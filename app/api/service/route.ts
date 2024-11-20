import { NextResponse } from 'next/server';
import FirecrawlApp, { ScrapeResponse } from '@mendable/firecrawl-js';
import { config } from 'dotenv';
config();
import { createClient } from '@supabase/supabase-js'
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";






export async function POST(request: Request) {
  const { urls, bringYourOwnFirecrawlApiKey } = await request.json();
  let firecrawlApiKey: string | undefined;
  let limit: number = 1000;
  let no_limit: boolean = false;
  if (bringYourOwnFirecrawlApiKey) {
    firecrawlApiKey = bringYourOwnFirecrawlApiKey;
    console.log("Using provided Firecrawl API key. Limit set to 1000");
    no_limit = true;
  } else {
    firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
    limit = 10;
    console.log("Using default limit of 10");
  }
  

  

  if (!firecrawlApiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set');
  }

  const app = new FirecrawlApp({ apiKey: firecrawlApiKey });


  let urlsToScrape = urls;

  //make sure url length is less than or equal to limit
  if (urlsToScrape && urlsToScrape.length > limit) {
    urlsToScrape = urlsToScrape.slice(0, limit);
  }
  const sampleUrl = urlsToScrape[0];
  let urlObj;
  if (!sampleUrl.startsWith('http://') && !sampleUrl.startsWith('https://')) {
    urlObj = new URL(`http://${sampleUrl}`);
  } else {
    urlObj = new URL(sampleUrl);
  }
  const stemUrl = `${urlObj.hostname}`;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase = createClient(supabaseUrl!, supabaseKey!);

  const { data: cacheData, error: cacheError } = await supabase
    .from('cache')
    .select('llmstxt, llmsfulltxt, cached_at')
    .eq('url', stemUrl)
    .eq('no_limit', no_limit)
    .single();

  if (cacheError) {
    console.error('Error fetching cache:', cacheError);
  } else if (cacheData) {
    const cacheAge = (new Date().getTime() - new Date(cacheData.cached_at).getTime()) / (1000 * 60 * 60 * 24);
    if (cacheAge < 3) {
      console.log(`Cache hit for ${stemUrl}`);
      return NextResponse.json({ llmstxt: cacheData.llmstxt, llmsfulltxt: cacheData.llmsfulltxt });
    }
  }

  let llmstxt = `# ${stemUrl} llms.txt\n\n`;
  let llmsFulltxt = `# ${stemUrl} llms-full.txt\n\n`;

  // Batch scrape the website

  if (!urls) {
    throw new Error('URLs are not defined');
  }

  // Scrape multiple websites (synchronous):
  const batchScrapeResult = await app.batchScrapeUrls(urls, {
    formats: ['markdown'],
    onlyMainContent: true,
  });



  if (!batchScrapeResult.success) {
    throw new Error(`Failed to scrape: ${batchScrapeResult.error}`);
  }
  for (const result of batchScrapeResult.data) {
    const metadata = result.metadata;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const DescriptionSchema = z.object({
      description: z.string(),
      title: z.string(),
    });

    const completion = await openai.beta.chat.completions.parse({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `Generate a 9-10 word description and a 3-4 word title of the entire page based on ALL the content one will find on the page for this url: ${metadata?.url}. This will help in a user finding the page for its intended purpose. Here is the content: ${result.markdown}`,
        }
      ],
      response_format: zodResponseFormat(DescriptionSchema, "description"),
    });

    const parsedResponse = completion.choices[0].message.parsed;
    const description = parsedResponse!.description;
    const title = parsedResponse!.title;
   
    llmstxt = llmstxt + `- [${title}](${metadata?.url}): ${description}\n`; 
    llmsFulltxt = llmsFulltxt + result.markdown;
  
  }


  if (!no_limit) {
    llmstxt = llmstxt + "\n\n*Note: This is a full scrape of the website, and may not be representative of the entire site. Please enter a Firecrawl API key to get the entire site at llmstxt.firecrawl.dev.*";
    llmsFulltxt = llmsFulltxt + "\n\n*Note: This is a full scrape of the website, and may not be representative of the entire site. Please enter a Firecrawl API key to get the entire site at llmsfulltxt.firecrawl.dev.*";
  }

  const { data, error } = await supabase
    .from('cache')
    .insert([
      { url: stemUrl, llmstxt: llmstxt, llmsfulltxt: llmsFulltxt, no_limit: no_limit }
    ]);

  if (error) {
    throw new Error(`Failed to insert into Supabase: ${error.message}`);
  }


  return NextResponse.json({ llmstxt: llmstxt, llmsFulltxt: llmsFulltxt });
}
