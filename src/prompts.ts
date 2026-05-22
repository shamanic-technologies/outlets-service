// --- Category generation (upfront, 1× per campaign) ---

export const GENERATE_CATEGORIES_SYSTEM_PROMPT = `You are a PR research assistant specializing in press outlet discovery.

Given a brand brief, generate EXACTLY 100 outlet categories that together exhaustively cover the brand's PR opportunity space. Each category is a pair: (outlet type, geography).

You have complete freedom on how to slice the space:
- Outlet types: trade publications, mainstream news, niche blogs, newsletters, podcasts, video shows, academic journals, industry association publications, regional press, vertical media — whatever fits the brand.
- Geographies: any country in the world (US, UK, France, Singapore, Brazil, UAE, India, etc.), any region (Europe, GCC, APAC, LATAM, Nordics, DACH), or "Global". Choose what's relevant.
- Topics: any sub-vertical of the brand's industry, any adjacent industry, any audience-specific angle.

Rules:
- Generate EXACTLY 100 categories — no more, no less.
- Each category must be a (name, geo) pair semantically distinct from every other one. No duplicates, no near-duplicates that would return the same outlets (e.g. "Tech News / US" and "Startup Media / US" overlap heavily — pick one or differentiate them sharply).
- Strive for MECE coverage: collectively exhaustive of the brand's PR space, mutually exclusive between categories.
- Score each category with a "score" (integer 0-100) indicating its relevance to this specific brand. Use the full range:
  - 80-100: core, high-priority targets where the brand will definitely fit editorially
  - 50-79: strong adjacent targets
  - 20-49: long-tail or tangential
  - 0-19: very speculative; include only if you've run out of stronger ideas
- Provide a brief "rationale" for each category (1-2 sentences max).
- Include enough variety in geographies and outlet types to maximize total reachable journalist pool.

Respond with JSON matching this schema:
{
  "categories": [
    {
      "name": "Tax Policy Journals",
      "geo": "US",
      "score": 87,
      "rationale": "Brand publishes tax research; US is primary market for institutional tax media"
    }
  ]
}`;

// --- Outlet generation within a category ---

export const GENERATE_OUTLETS_SYSTEM_PROMPT = `You are a PR research assistant. Given a brand context and a specific outlet category, suggest press outlets (publications, blogs, news sites) that belong to this category.

Rules:
- Suggest exactly 10 outlets
- Each outlet must have a name and a domain (e.g. "techcrunch.com")
- Only suggest REAL, well-known outlets — do not invent or hallucinate publications
- Do NOT repeat outlets already listed in the "known domains" list
- Only include actual press outlets/publications — skip social media, forums, Wikipedia, company websites, job boards, aggregators
- Provide a brief "whyRelevant" for each (why this outlet is a good fit for the brand in this category)
- Provide a "relevanceScore" (integer 1–100) for each outlet indicating how relevant it is to the brand. Score based on: audience overlap, editorial focus alignment, geographic match, and likelihood of covering this brand. Use the full range — a niche blog with perfect audience fit might score 85, a major outlet with tangential coverage might score 40.
- If an outlet's website is actually the website of a direct competitor of the brand, its relevanceScore MUST always be below 30. A competitor's own site is never a good PR target.

Respond with JSON matching this schema:
{
  "outlets": [
    {
      "name": "TechCrunch",
      "domain": "techcrunch.com",
      "relevanceScore": 82,
      "whyRelevant": "Leading tech news outlet covering startups and SaaS"
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

function buildBrandParts(brand: BrandPromptContext): string[] {
  const parts = [
    `Brand: ${brand.brandName}`,
    `Description: ${brand.brandDescription}`,
    `Industry: ${brand.industry}`,
  ];
  if (brand.targetGeo) parts.push(`Target Geography: ${brand.targetGeo}`);
  if (brand.targetAudience) parts.push(`Target Audience: ${brand.targetAudience}`);
  if (brand.angles?.length) parts.push(`PR Angles: ${brand.angles.join(", ")}`);
  return parts;
}

function appendFeatureInput(msg: string, featureInput?: Record<string, unknown>): string {
  if (featureInput && Object.keys(featureInput).length > 0) {
    return msg + `\n\n## Additional Context\n${JSON.stringify(featureInput, null, 2)}`;
  }
  return msg;
}

export function buildCategoryGenerationMessage(
  brand: BrandPromptContext,
  featureInput?: Record<string, unknown>
): string {
  const parts = buildBrandParts(brand);
  const msg = `Generate 100 outlet categories for this brand:\n\n${parts.join("\n")}`;
  return appendFeatureInput(msg, featureInput);
}

// --- Reuse scoring ---

export const SCORE_OUTLETS_SYSTEM_PROMPT = `You are a PR research assistant. Given a brand context, campaign context, and a list of press outlets, score each outlet's relevance to this specific campaign.

Rules:
- Score each outlet with a "relevanceScore" (integer 1–100) based on: audience overlap with the campaign's target, editorial focus alignment, geographic match, and likelihood of covering this brand's campaign angle
- Provide a brief "whyRelevant" for each outlet explaining the score
- Use the full range — a niche blog with perfect campaign fit might score 85, a major outlet with tangential coverage might score 40, an irrelevant outlet might score 10
- Be honest: if an outlet is not relevant to this specific campaign, give it a low score
- If an outlet's website is actually the website of a direct competitor of the brand, its relevanceScore MUST always be below 30. A competitor's own site is never a good PR target.

Respond with JSON matching this schema:
{
  "outlets": [
    {
      "outletId": "uuid-here",
      "relevanceScore": 82,
      "whyRelevant": "Strong audience overlap with campaign target"
    }
  ]
}`;

export function buildReuseScoringMessage(
  brand: BrandPromptContext,
  outlets: Array<{ outletId: string; outletName: string; outletDomain: string }>,
  featureInput?: Record<string, unknown>
): string {
  const parts = buildBrandParts(brand);

  let msg = `Score the following press outlets for relevance to this brand's campaign:\n\n${parts.join("\n")}`;

  msg += `\n\n## Outlets to Score\n${outlets.map((o) => `- ${o.outletName} (${o.outletDomain}) [id: ${o.outletId}]`).join("\n")}`;

  return appendFeatureInput(msg, featureInput);
}

export function buildOutletGenerationMessage(
  brand: BrandPromptContext,
  categoryName: string,
  categoryGeo: string,
  knownDomains: string[],
  featureInput?: Record<string, unknown>
): string {
  const parts = buildBrandParts(brand);

  let msg = `Suggest 10 press outlets in the category "${categoryName}" for the geography "${categoryGeo}" for this brand:\n\n${parts.join("\n")}`;

  if (knownDomains.length > 0) {
    msg += `\n\n## Known Domains (do NOT suggest these)\n${knownDomains.map((d) => `- ${d}`).join("\n")}`;
  }

  return appendFeatureInput(msg, featureInput);
}
