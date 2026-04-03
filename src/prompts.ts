// --- Category generation ---

export const GENERATE_CATEGORIES_SYSTEM_PROMPT = `You are a PR research assistant specializing in press outlet discovery.

Given a brand brief, generate outlet categories. Each category is a pair: (outlet type, geography).

Outlet types are broad publication categories like: "Tech News", "Business News", "SaaS Blogs", "Industry Trade Publications", "Startup Media", "Lifestyle Magazines", "Real Estate Publications", "Finance & Investment News", "Marketing Blogs", etc.

Geography is a region or country like: "US", "UK", "Europe", "Australia", "Global", "DACH", "Nordics", "Southeast Asia", etc.

Rules:
- Generate exactly 10 categories
- Rank them by relevance to the brand (rank 1 = most relevant)
- Include a brief rationale for each
- Mix broad and niche categories
- Mix geographies relevant to the brand's target markets
- Do NOT repeat categories that were already generated (see "already used" list)

Respond with JSON matching this schema:
{
  "categories": [
    {
      "name": "Tech News",
      "geo": "US",
      "rank": 1,
      "rationale": "Brand is a US tech company, tech news outlets are the primary target"
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

Respond with JSON matching this schema:
{
  "outlets": [
    {
      "name": "TechCrunch",
      "domain": "techcrunch.com",
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
  alreadyUsed: Array<{ name: string; geo: string }>,
  featureInput?: Record<string, unknown>
): string {
  const parts = buildBrandParts(brand);

  let msg = `Generate outlet categories for this brand:\n\n${parts.join("\n")}`;

  if (alreadyUsed.length > 0) {
    msg += `\n\n## Already Used Categories (do NOT repeat these)\n${alreadyUsed.map((c) => `- ${c.name} / ${c.geo}`).join("\n")}`;
  }

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
