import { Video } from "@the-convocation/twitter-scraper/dist/tweets.js";

import { BlueskyCard } from "../../types/card.js";
import { Media } from "../../types/media.js";

interface BlueskyBlob {
  mimeType: string;
  blobData: Uint8Array;
  card: BlueskyCard | null;
}

/**
 * An async method to convert a Blob to an upload-compatible Bluesky Blob.
 * @returns BlueskyBlob
 */
export const parseBlobForBluesky = async (
  blob: Blob,
  previewBlob: Blob | null = null,
  media: Media | null = null,
): Promise<BlueskyBlob> => {
  return new Promise<BlueskyBlob>((resolve, reject) => {
    const allowedMimeTypes = ["image/jpeg", "image/jpg", "image/png"];
    const mimeType = blob.type;

    if (mimeType === "video/mp4" && previewBlob && media && previewBlob.type) {
      previewBlob.arrayBuffer().then((ab) => {
        const buffer = Buffer.from(ab);
        const previewData = new Uint8Array(buffer);
        const video = media as Video;
        const videoCard = {
          uri: video.url as string,
          title: "⏵Video",
          description: "",
          thumb: null,
        };
        resolve({
          mimeType: previewBlob.type,
          blobData: previewData,
          card: videoCard,
        });
      });
    }

    blob.arrayBuffer().then((ab) => {
      const buffer = Buffer.from(ab);
      const data = new Uint8Array(buffer);

      if (!mimeType || !allowedMimeTypes.includes(mimeType)) {
        reject(`Media type not supported (${mimeType})`);
      } else {
        resolve({ mimeType, blobData: data, card: null });
      }
    });
  });
};
