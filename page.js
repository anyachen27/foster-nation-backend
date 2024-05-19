const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');
const util = require('util');
const setTimeoutPromise = util.promisify(setTimeout);

const genAI = new GoogleGenerativeAI("AIzaSyAXpoyroqvJWKQBr9IpTstxEqcKGdR-448");

const MAX_LINKS = 5; // limit the number of links processed
const MAX_RETRIES = 3; // max number of retries for api calls

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:104.0) Gecko/20100101 Firefox/104.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.64'
];

async function fetchWebsiteContent(pageUrl, userAgent) {
    try {
        const { data, headers } = await axios.get(pageUrl, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });
        return { data, headers };
    } catch (error) {
        console.error(`Error fetching content from ${pageUrl}:`, error.message);
        return null;
    }
}

async function extractContentWithLinks(baseUrl) {
    const htmlData = await fetchWebsiteContent(baseUrl, USER_AGENTS[0]);
    if (!htmlData) {
        console.error(`No HTML content fetched from ${baseUrl}`);
        return [];
    }

    const $ = cheerio.load(htmlData.data);
    const linksWithText = [];
    $('a').each((index, element) => {
        const href = $(element).attr('href');
        const linkText = $(element).text().toLowerCase().trim();
        const surroundingText = $(element).parent().text().toLowerCase().trim();
        if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
            const absoluteUrl = url.resolve(baseUrl, href);
            linksWithText.push({
                linkText: linkText,
                surroundingText: surroundingText,
                url: absoluteUrl
            });
        }
    });

    // remove empty/duplicate entries
    const cleanedLinksWithText = linksWithText.filter(link => link.linkText && link.linkText.trim() !== '');

    // log cleaned extracted links w/ surrounding text for debugging
    console.log("Extracted links with surrounding text:", cleanedLinksWithText.map(link => ({
        linkText: link.linkText,
        surroundingText: link.surroundingText
    })));

    return cleanedLinksWithText;
}

async function extractContentFromRelevantPages(baseUrl, userKeywords) {
    const linksWithText = await extractContentWithLinks(baseUrl);
    if (linksWithText.length === 0) {
        console.error("No links with surrounding text found on the main page.");
        return '';
    }

    // log user keywords for debugging
    console.log("User keywords:", userKeywords);

    // keyword matching: partial matches and non-exact matching
    const relevantLinks = linksWithText.filter(link =>
        userKeywords.some(keyword => link.surroundingText.includes(keyword.toLowerCase().replace(/[^\w\s]/gi, '')))
    ).slice(0, MAX_LINKS); // limit # of links processed

    if (relevantLinks.length === 0) {
        console.error("No relevant links found matching user keywords.");
        return '';
    }

    // log relevant links for debugging
    console.log("Relevant links with surrounding text:", relevantLinks.map(link => ({
        linkText: link.linkText,
        surroundingText: link.surroundingText,
        url: link.url
    })));

    const contents = [];
    for (const link of relevantLinks) {
        console.log(`Fetching content from relevant link: ${link.url}`);
        let content = '';
        for (const userAgent of USER_AGENTS) {
            content = await extractContentFromPage(link.url, userAgent);
            if (content) {
                contents.push(content);
                break;
            }
            await setTimeoutPromise(500); // adding delay to prevent rate limiting
        }
    }

    return contents.join('\n');
}

async function extractContentFromPage(pageUrl, userAgent) {
    try {
        const htmlData = await fetchWebsiteContent(pageUrl, userAgent);
        if (!htmlData) {
            throw new Error('No HTML content fetched');
        }

        const $ = cheerio.load(htmlData.data);
        let textContent = '';

        // extract text content from specific sections of website
        $('section, p, h1, h2, h3, h4, h5, h6').each((index, element) => {
            textContent += $(element).text() + '\n';
        });

        return textContent.trim(); // ensure no extra whitespace
    } catch (error) {
        console.error(`Error fetching content from ${pageUrl}: ${error.message}`);
        return '';
    }
}

async function getChatbotResponse(prompt, retries = MAX_RETRIES) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        return text;
    } catch (error) {
        console.error("Error generating AI response:", error.message);
        if (retries > 0) {
            console.log(`Retrying... (${MAX_RETRIES - retries + 1} attempts left)`);
            await setTimeoutPromise(2000); // wait 2 seconds before retrying
            return getChatbotResponse(prompt, retries - 1);
        } else {
            return "I'm sorry, but I'm currently unable to assist you. Please try again later.";
        }
    }
}

async function getFallbackChatbotResponse(prompt, retries = MAX_RETRIES) {
    try {
        const model = genAI.getGenerativeModel({ model: "text-bison-001" }); // using a different model as a fallback
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        return text;
    } catch (error) {
        console.error("Error generating fallback AI response:", error.message);
        if (retries > 0) {
            console.log(`Retrying fallback... (${MAX_RETRIES - retries + 1} attempts left)`);
            await setTimeoutPromise(2000); // wait 2 seconds before retrying
            return getFallbackChatbotResponse(prompt, retries - 1);
        } else {
            return "I'm sorry, but I'm currently unable to assist you. Please try again later.";
        }
    }
}

async function run() {
    const baseUrl = 'https://www.fosternation.org';

    const userQuery = "How does Foster Nation help empower youth?";
    const userKeywords = userQuery.toLowerCase().split(/\s+/); // convert to lowercase, split by space for matching

    const websiteContent = await extractContentFromRelevantPages(baseUrl, userKeywords);

    if (!websiteContent) {
        console.error("Failed to fetch or extract content from the website. Expanding search to the entire API database.");

        const finalPrompt = `
            Based on available data, please provide information and assistance related to the user's query.

            User Query: ${userQuery}
        `;

        try {
            const fallbackResponse = await getFallbackChatbotResponse(finalPrompt);
            console.log(fallbackResponse);
        } catch (error) {
            console.error("An error occurred while generating the fallback chatbot response:", error.message);
        }

        return;
    }

    const finalPrompt = `
        Based on the content from the Foster Nation website, please provide information and assistance related to the user's query.

        Website Content:
        ${websiteContent}

        User Query: ${userQuery}
    `;

    try {
        const chatbotResponse = await getChatbotResponse(finalPrompt);
        console.log(chatbotResponse);
    } catch (error) {
        console.error("An error occurred while generating the chatbot response:", error.message);
    }
}

run().catch(error => {
    console.error("An error occurred while running the script:", error.message);
});