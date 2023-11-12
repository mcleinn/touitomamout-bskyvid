import bsky, { BskyAgent } from "@atproto/api";
import { Link } from "@atproto/api/dist/client/types/app/bsky/richtext/facet.js";
import { Video } from "@the-convocation/twitter-scraper/dist/tweets.js";
import { Ora } from "ora";

import { DEBUG, VOID } from "../constants.js";
import { scrapeOpenGraphTags } from "../helpers/bluesky/og-scraper.js";
import { getCachedPosts } from "../helpers/cache/get-cached-posts.js";
import { savePostToCache } from "../helpers/cache/save-post-to-cache.js";
import { oraProgress } from "../helpers/logs/index.js";
import { parseBlobForBluesky } from "../helpers/medias/parse-blob-for-bluesky.js";
import { getPostExcerpt } from "../helpers/post/get-post-excerpt.js";
import { BlueskyCard } from "../types/card.js";
import {
  BlueskyCacheChunk,
  BlueskyMediaAttachment,
  Media,
  Platform,
} from "../types/index.js";
import { BlueskyPost } from "../types/post.js";
import { mediaDownloaderService } from "./index.js";

const BLUESKY_MEDIA_IMAGES_MAX_COUNT = 4;

/**
 * An async method in charge of handling Bluesky posts computation & uploading.
 */
export const blueskySenderService = async (
  client: BskyAgent | null,
  post: BlueskyPost | null,
  medias: Media[],
  log: Ora,
) => {
  if (!client || !post) {
    return;
  }

  // Detect links
  const findFirstLink = (
    mains: bsky.AppBskyRichtextFacet.Main[],
  ): Link | undefined => {
    for (const main of mains) {
      const linkFeature = main.features.find(
        (feature) => "uri" in feature,
      ) as Link;
      if (linkFeature) {
        return linkFeature; // This will return the first Link object found
      }
    }
    return undefined;
  };

  function removeUri(strings: string[], substring: string): string[] {
    const index = strings.findIndex((str) => str.includes(substring));

    if (index !== -1) {
      strings[index] = strings[index].replace(substring, "");
      if (strings[index] === "") {
        strings.splice(index, 1);
      }
    }

    return strings;
  }

  let card: BlueskyCard | null = null;
  if (medias.length === 0) {
    // create preview card based on first link only when there are no image or video attachments
    // image posts do not need cards, and videos create their own preview card in parse-blob-for-bluesky
    for (const chunk of post.chunks) {
      const richText = new bsky.RichText({ text: chunk });
      await richText.detectFacets(client);
      if (!richText.facets) continue;

      const firstMainWithLink = findFirstLink(
        richText.facets as bsky.AppBskyRichtextFacet.Main[],
      );
      if (!firstMainWithLink?.uri) continue;
      const ogTags = await scrapeOpenGraphTags(firstMainWithLink?.uri);
      card = {
        uri: firstMainWithLink?.uri,
        title: ogTags.title || "",
        description: ogTags.description || "",
        thumb: null,
      };
      // insert preview image to medias
      if (ogTags.image)
        medias.unshift({ type: "image", url: ogTags.image } as Media);

      break;
    }

    // remove link from post text to save post length
    if (card?.uri) post.chunks = removeUri(post.chunks, card?.uri);
  }

  // Medias
  const mediaAttachments: BlueskyMediaAttachment[] = [];
  for (const media of medias) {
    if (!media.url) {
      continue;
    }
    if (
      (media.type === "image" &&
        mediaAttachments.length < BLUESKY_MEDIA_IMAGES_MAX_COUNT - 1) ||
      (media.type === "video" && mediaAttachments.length === 0)
    ) {
      // Download
      log.text = `medias: ↓ (${mediaAttachments.length + 1}/${
        medias.length
      }) downloading`;
      const mediaBlob = await mediaDownloaderService(media.url);
      if (!mediaBlob) {
        continue;
      }

      const video = media as Video;
      const previewBlob =
        video && video.preview
          ? await mediaDownloaderService(video.preview)
          : null;

      const blueskyBlob = await parseBlobForBluesky(
        mediaBlob,
        previewBlob,
        media,
      ).catch((err) => {
        if (DEBUG) {
          console.log(err);
        }
        log.warn(
          `medias: ↯ (${mediaAttachments.length + 1}/${
            medias.length
          }) skipped for ☁️ bluesky : ${err}`,
        );
        return null;
      });

      if (!blueskyBlob) {
        continue;
      }

      if (blueskyBlob.card) card = blueskyBlob.card;

      // Upload
      log.text = `medias: ↑ (${mediaAttachments.length + 1}/${
        medias.length
      }) uploading`;

      await client
        .uploadBlob(blueskyBlob.blobData, { encoding: blueskyBlob.mimeType })
        .then(async (mediaSent) => {
          const m: BlueskyMediaAttachment = { ...mediaSent };
          if (media.type === "image" && media.alt_text) {
            m.alt_text = media.alt_text;
          }
          if (card) {
            card.thumb = { ...mediaSent };
          }
          mediaAttachments.push(m);
        })
        .catch((err) => {
          log.fail(err);
          return null;
        });
    }
  }

  // When no compatible media has been found and no text is present, skip the post.
  if (!mediaAttachments.length && !post.tweet.text) {
    log.warn(
      `☁️ | post skipped: no compatible media nor text to post (tweet: ${post.tweet.id})`,
    );
    return;
  }

  let chunkIndex = 0;
  const chunkReferences: Array<BlueskyCacheChunk & { uri: string }> = [];

  /**
   * For each chunk, create and send a toot.
   * If this is the first chunk, we attach medias to the toot if any.
   * If the tweet is a reply, we reference it.
   * If the tweet is long, each child chunk will reference the previous one as replyId.
   */
  for (const chunk of post.chunks) {
    const richText = new bsky.RichText({ text: chunk });
    await richText.detectFacets(client);

    const data: {
      [x: string]: unknown;
    } = {
      $type: "app.bsky.feed.post",
      text: richText.text,
      facets: richText.facets,
      createdAt: new Date(post.tweet.timestamp || Date.now()).toISOString(),
    };

    // Inject embed data only for the first chunk.
    if (chunkIndex === 0) {
      const quoteRecord = post.quotePost
        ? {
            record: {
              $type: "app.bsky.embed.record",
              cid: post.quotePost.cid,
              uri: post.quotePost.uri,
            },
          }
        : {};

      const mediaRecord = mediaAttachments.length
        ? {
            media: {
              $type: "app.bsky.embed.images",
              images: mediaAttachments.map((i) => ({
                alt: i.alt_text ?? "",
                image: i.data.blob.original,
              })),
            },
          }
        : {};

      const external = card
        ? {
            external: {
              $type: "app.bsky.embed.external",
              uri: card.uri,
              title: card.title,
              description: card.description,
              thumb: card.thumb?.data.blob.original,
            },
          }
        : {};

      let embed = {};

      if (Object.keys(external).length) {
        embed = {
          ...external,
          $type: "app.bsky.embed.external",
        };
      } else if (Object.keys(quoteRecord).length) {
        embed = {
          ...quoteRecord,
          $type: "app.bsky.embed.record",
        };

        if (Object.keys(mediaRecord).length) {
          embed = {
            ...embed,
            ...mediaRecord,
            $type: "app.bsky.embed.recordWithMedia",
          };
        }
      } else if (Object.keys(mediaRecord).length) {
        embed = {
          ...mediaRecord.media,
        };
      }

      if (Object.keys(embed).length) {
        data.embed = embed;
      }
    }

    if (chunkIndex === 0) {
      if (post.replyPost) {
        data.reply = {
          root: {
            cid: post.replyPost.cid,
            uri: post.replyPost.uri,
          },
          parent: {
            cid: post.replyPost.cid,
            uri: post.replyPost.uri,
          },
        };
      }
    } else {
      data.reply = {
        root: {
          cid: chunkReferences[0].cid,
          uri: chunkReferences[0].uri,
        },
        parent: {
          cid: chunkReferences[chunkIndex - 1].cid,
          uri: chunkReferences[chunkIndex - 1].uri,
        },
      };
    }

    log.text = `☁️ | post sending: ${getPostExcerpt(post.tweet.text ?? VOID)}`;

    // Post
    await client
      .post({ ...data })
      .then(async (createdPost) => {
        oraProgress(
          log,
          { before: "☁️ | post sending: " },
          chunkIndex,
          post.chunks.length,
        );

        // Save post ID to be able to reference it while posting the next chunk.
        chunkReferences.push({
          cid: createdPost.cid,
          uri: createdPost.uri,
          rkey:
            createdPost.uri.match(/\/(?<rkey>\w+)$/)?.groups?.["rkey"] || "",
        });

        // If this is the last chunk, save the all chunks ID to the cache.
        if (chunkIndex === post.chunks.length - 1) {
          log.succeed(
            `☁️ | post sent: ${getPostExcerpt(post.tweet.text ?? VOID)}${
              chunkReferences.length > 1
                ? ` (${chunkReferences.length} chunks)`
                : ""
            }`,
          );

          const cache = await getCachedPosts();
          await savePostToCache({
            cache,
            tweetId: post.tweet.id,
            data: chunkReferences.map((ref) => ({
              rkey: ref.rkey,
              cid: ref.cid,
            })),
            platform: Platform.BLUESKY,
          });
        }

        chunkIndex++;
      })
      .catch((error) => {
        // Handle the error
        console.error("Error sending post:", error);
        console.error("Created at: ", data.createdAt);
        console.error("Text: ", data.text);
      });
  }
};
