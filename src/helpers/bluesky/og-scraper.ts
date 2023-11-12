// ogScraper.ts
import * as cheerio from "cheerio";
import fetch from "node-fetch";
import sharp from "sharp";

export async function scrapeOpenGraphTags(url: string): Promise<{
  title: string | null;
  description: string | null;
  image: string | null;
}> {
  async function fetchAndValidateImage(uri: string): Promise<string | null> {
    try {
      const response = await fetch(uri, { method: "HEAD" });
      const contentLength = response.headers.get("content-length");

      if (contentLength && parseInt(contentLength, 10) <= 1048576) {
        const imageResponse = await fetch(uri);
        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const metadata = await sharp(buffer).metadata();

        if (
          metadata.width &&
          metadata.height &&
          metadata.width >= 640 &&
          metadata.height >= 480
        ) {
          return uri;
        }
      }
    } catch (error) {
      console.error(`Error fetching image ${uri}:`, error);
    }
    return null;
  }

  // Fetch and load the HTML content with Cheerio
  const html = await (await fetch(url)).text();
  const $ = cheerio.load(html);

  const title = $('meta[property="og:title"]').attr("content") || null;
  const description =
    $('meta[property="og:description"]').attr("content") || null;

  // Attempt to use og:image if it meets the criteria
  let image = await fetchAndValidateImage(
    $('meta[property="og:image"]').attr("content") || "",
  );

  // If og:image isn't suitable, find the next best image
  if (!image) {
    for (const elem of $("img").toArray()) {
      const src = $(elem).attr("src");
      if (src) {
        const absoluteSrc = new URL(src, url).href;
        image = await fetchAndValidateImage(absoluteSrc);
        if (image) {
          break;
        }
      }
    }
  }

  // Return the object with the scraped information
  return { title, description, image };
}
