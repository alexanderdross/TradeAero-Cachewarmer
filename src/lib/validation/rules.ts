/**
 * Per-`@type` validation rules. Modeled on Google's structured-data
 * requirements at https://developers.google.com/search/docs/appearance/structured-data
 * — `required` fields are hard-fails (rich-result ineligible), `recommended`
 * fields produce warnings (rich-result eligible but reduced features).
 *
 * Only types that TradeAero actually emits today are covered. Unknown
 * @types fall through to the @context / @type sanity check in the
 * local validator and are otherwise ignored.
 */

export interface TypeRule {
  required: string[];
  recommended: string[];
  /** Validates per-item shape inside an array field. */
  itemRules?: Record<string, TypeRule>;
}

export const TYPE_RULES: Record<string, TypeRule> = {
  Product: {
    required: ['name', 'image'],
    recommended: ['description', 'brand', 'offers', 'aggregateRating', 'review'],
  },
  Vehicle: {
    // Vehicle is most useful merged with Product (TradeAero does this on
    // aircraft listings). When emitted standalone, treat the same essentials
    // as Product plus the model identifiers Google recommends for Vehicle.
    required: ['name'],
    recommended: ['vehicleModelDate', 'manufacturer', 'model', 'mileageFromOdometer', 'image'],
  },
  Offer: {
    required: ['price', 'priceCurrency'],
    recommended: ['availability', 'url', 'itemCondition'],
  },
  JobPosting: {
    // Per https://developers.google.com/search/docs/appearance/structured-data/job-posting
    required: ['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation'],
    recommended: ['employmentType', 'baseSalary', 'validThrough', 'identifier'],
  },
  Organization: {
    required: ['name'],
    recommended: ['url', 'logo', 'sameAs', 'contactPoint'],
  },
  WebSite: {
    required: ['name', 'url'],
    recommended: ['potentialAction'],
  },
  BreadcrumbList: {
    required: ['itemListElement'],
    recommended: [],
    itemRules: {
      itemListElement: {
        required: ['position', 'name', 'item'],
        recommended: [],
      },
    },
  },
  FAQPage: {
    required: ['mainEntity'],
    recommended: [],
    itemRules: {
      mainEntity: {
        required: ['name', 'acceptedAnswer'],
        recommended: [],
      },
    },
  },
  Question: {
    required: ['name', 'acceptedAnswer'],
    recommended: [],
  },
  Answer: {
    required: ['text'],
    recommended: [],
  },
  VideoObject: {
    // Per https://developers.google.com/search/docs/appearance/structured-data/video
    required: ['name', 'thumbnailUrl', 'uploadDate'],
    recommended: ['description', 'duration', 'contentUrl', 'embedUrl'],
  },
  ImageObject: {
    required: ['url'],
    recommended: ['width', 'height', 'caption'],
  },
  ListItem: {
    required: ['position'],
    recommended: ['name', 'item'],
  },
};

/**
 * Resolve a node's @type to one of the canonical keys in TYPE_RULES.
 * Handles arrays (`["Product","Vehicle"]` → "Product"; the secondary type
 * is validated separately by the caller iterating each known @type).
 */
export function expandTypes(rawType: unknown): string[] {
  if (typeof rawType === 'string') return [rawType];
  if (Array.isArray(rawType)) return rawType.filter((t): t is string => typeof t === 'string');
  return [];
}
