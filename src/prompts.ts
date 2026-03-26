export const GENERATE_QUERIES_SYSTEM_PROMPT = `You are a PR research assistant specializing in press outlet discovery.

Given a brand brief, generate Google search queries that will surface relevant press outlets (publications, blogs, news sites) where this brand could get coverage.

Generate a mix of:
- Direct outlet discovery queries (e.g. "best [industry] publications", "top [topic] blogs")
- News-style queries to find outlets that cover similar topics (e.g. "[competitor] press coverage", "[industry] news [year]")
- Niche/vertical queries for specialized outlets
- Geographic queries if a target region is specified

Rules:
- Generate 8-12 queries
- Mark each as "web" or "news" type
- Include a brief rationale for each query
- Focus on finding the OUTLETS (publications), not individual articles
- Vary query specificity: some broad, some niche

Respond with JSON matching this schema:
{
  "queries": [
    {
      "query": "the search query string",
      "type": "web" | "news",
      "rationale": "why this query will surface relevant outlets"
    }
  ]
}`;

export const SCORE_OUTLETS_SYSTEM_PROMPT = `You are a PR research assistant that evaluates press outlets for brand relevance.

Given a brand context and a list of search results, identify unique press outlets and score their relevance.

Rules:
- Deduplicate by domain (e.g. techcrunch.com appears once even if found in multiple results)
- Only include actual press outlets/publications — skip social media, forums, Wikipedia, company websites, job boards, aggregators
- Score relevance 0-100 based on:
  - Topic alignment with the brand's industry/angles
  - Audience overlap with target audience
  - Publication authority and reach
  - Geographic relevance if specified
- Provide a clear "whyRelevant" (what makes this outlet a good fit)
- Provide a clear "whyNotRelevant" (any concerns or mismatches)
- Include an "overallRelevance" summary: "high", "medium", or "low"

Respond with JSON matching this schema:
{
  "outlets": [
    {
      "name": "Publication Name",
      "url": "https://domain.com",
      "domain": "domain.com",
      "relevanceScore": 85,
      "whyRelevant": "Covers HR tech extensively, reaches CTOs and HR directors",
      "whyNotRelevant": "US-focused, limited European readership",
      "overallRelevance": "high"
    }
  ]
}`;

export interface BrandPromptContext {
  brandName: string;
  brandDescription: string;
  industry: string;
  targetGeo?: string;
  targetAudience?: string;
  angles?: string[];
}

export function buildQueryGenerationMessage(
  brand: BrandPromptContext,
  featureInput?: Record<string, unknown>
): string {
  const parts = [
    `Brand: ${brand.brandName}`,
    `Description: ${brand.brandDescription}`,
    `Industry: ${brand.industry}`,
  ];
  if (brand.targetGeo) parts.push(`Target Geography: ${brand.targetGeo}`);
  if (brand.targetAudience) parts.push(`Target Audience: ${brand.targetAudience}`);
  if (brand.angles?.length) parts.push(`PR Angles: ${brand.angles.join(", ")}`);

  let msg = `Generate Google search queries to find relevant press outlets for this brand:\n\n${parts.join("\n")}`;

  if (featureInput && Object.keys(featureInput).length > 0) {
    msg += `\n\n## Additional Context\n${JSON.stringify(featureInput, null, 2)}`;
  }

  return msg;
}

export function buildScoringMessage(
  brand: BrandPromptContext,
  searchResults: Array<{ query: string; results: Array<{ title: string; url: string; snippet: string; domain: string }> }>,
  featureInput?: Record<string, unknown>
): string {
  const contextParts = [
    `Brand: ${brand.brandName}`,
    `Description: ${brand.brandDescription}`,
    `Industry: ${brand.industry}`,
  ];
  if (brand.targetGeo) contextParts.push(`Target Geography: ${brand.targetGeo}`);
  if (brand.targetAudience) contextParts.push(`Target Audience: ${brand.targetAudience}`);

  let msg = `Evaluate these search results and identify relevant press outlets for this brand:

## Brand Context
${contextParts.join("\n")}

## Search Results
${JSON.stringify(searchResults, null, 2)}`;

  if (featureInput && Object.keys(featureInput).length > 0) {
    msg += `\n\n## Additional Context\n${JSON.stringify(featureInput, null, 2)}`;
  }

  return msg;
}
