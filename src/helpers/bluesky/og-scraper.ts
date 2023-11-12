// ogScraper.ts
import * as cheerio from "cheerio";
import fetch from "node-fetch";

export async function scrapeOpenGraphTags(url: string): Promise<{
  title: string | null;
  description: string | null;
  image: string | null;
}> {
  try {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const title = $('meta[property="og:title"]').attr("content") || null;
    const description =
      $('meta[property="og:description"]').attr("content") || null;
    const image = $('meta[property="og:image"]').attr("content") || null;

    return {
      title,
      description,
      image,
    };
  } catch (error) {
    console.error("Error scraping Open Graph tags:", error);
    throw error;
  }
}
