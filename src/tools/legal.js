import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Legal AI stub — search laws, find templates.
 * Swap for real API (LexisNexis, Westlaw, CourtListener, Google Custom Search) later.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "data");
const TEMPLATE_PATH = join(DIR, "legal_templates.json");

const TEMPLATES = [
  { id: "tpl_nda", name: "NDA (Mutual)", category: "contracts", jurisdiction: "US", description: "Standard mutual confidentiality agreement" },
  { id: "tpl_engagement", name: "Engagement Letter", category: "contracts", jurisdiction: "US", description: "Professional services engagement letter" },
  { id: "tpl_demand", name: "Demand Letter", category: "litigation", jurisdiction: "US", description: "Formal demand for payment/performance" },
  { id: "tpl_mou", name: "MOU", category: "contracts", jurisdiction: "US", description: "Memorandum of understanding" },
  { id: "tpl_poa", name: "Power of Attorney", category: "personal", jurisdiction: "US", description: "General durable power of attorney" },
  { id: "tpl_llc", name: "LLC Operating Agreement", category: "business", jurisdiction: "US", description: "Multi-member LLC operating agreement" },
];

function ensureStore() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  if (!existsSync(TEMPLATE_PATH)) {
    writeFileSync(TEMPLATE_PATH, JSON.stringify(TEMPLATES, null, 2), "utf8");
  }
}

export async function searchLaw(query) {
  // Stub: return structured mock results
  const q = query.toLowerCase();
  const results = [
    { id: "law_1", title: "Federal Rules of Civil Procedure Rule 26", jurisdiction: "US Federal", relevance: 0.92, snippet: "Duty to disclose...", url: "https://www.law.cornell.edu/rules/frcp/rule_26" },
    { id: "law_2", title: "California Civil Code § 1542", jurisdiction: "California", relevance: 0.87, snippet: "General release does not extend to claims...", url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1542" },
    { id: "law_3", title: "GDPR Article 17 — Right to Erasure", jurisdiction: "EU", relevance: 0.81, snippet: "The data subject shall have the right...", url: "https://gdpr.eu/article-17-right-to-be-forgotten/" },
  ].filter((r) => r.title.toLowerCase().includes(q) || r.snippet.toLowerCase().includes(q) || q.length < 3);
  return results.slice(0, 5);
}

export async function findTemplates(filters = {}) {
  ensureStore();
  const data = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
  let results = data;
  if (filters.category) results = results.filter((t) => t.category === filters.category);
  if (filters.jurisdiction) results = results.filter((t) => t.jurisdiction === filters.jurisdiction);
  return results;
}

export async function getTemplate(id) {
  ensureStore();
  const data = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
  return data.find((t) => t.id === id) ?? null;
}