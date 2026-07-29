import type { Category, CategoryType } from "@/types";

export interface MigrationResult {
  data: unknown;
  migrated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function migratedCategoryId(type: CategoryType, name: string): string {
  let hash = 0x811c9dc5;
  const input = `${type}\u0000${name}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `migrated-${type}-${hash.toString(16).padStart(8, "0")}`;
}

function categoryTypeForRawTransaction(type: unknown): CategoryType | undefined {
  if (type === "income") return "income";
  if (type === "expense" || type === "refund") return "expense";
  return undefined;
}

function migrateV1ToV2(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.accounts) || !Array.isArray(raw.transactions)) {
    throw new Error("Finance data is missing its accounts or transactions list. Restore data.json from a backup.");
  }

  const categories = new Map<string, Category>();
  const categoryIds = new Map<string, string>();
  const usedIds = new Map<string, string>();
  const transactions = raw.transactions.map((value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const type = categoryTypeForRawTransaction(value.type);
    const category = typeof value.category === "string" && value.category.length > 0 ? value.category : undefined;
    if (!type || category === undefined) return { ...value };
    const key = `${type}\u0000${category}`;
    let categoryId = categoryIds.get(key);
    if (categoryId === undefined) {
      categoryId = migratedCategoryId(type, category);
      const collision = usedIds.get(categoryId);
      if (collision !== undefined && collision !== key) {
        let suffix = 2;
        while (usedIds.has(`${categoryId}-${suffix}`)) suffix += 1;
        categoryId = `${categoryId}-${suffix}`;
      }
      usedIds.set(categoryId, key);
      categoryIds.set(key, categoryId);
      const timestamp = typeof value.createdAt === "string" ? value.createdAt : "1970-01-01T00:00:00.000Z";
      categories.set(key, { id: categoryId, name: category, type, archived: false, createdAt: timestamp, updatedAt: timestamp });
    }
    return { ...value, categoryId };
  });

  const settings = isRecord(raw.settings) ? { ...raw.settings, calendar: "gregorian" } : { calendar: "gregorian" };
  return {
    ...raw,
    schemaVersion: 2,
    settings,
    categories: [...categories.values()],
    budgets: [],
    recurringRules: [],
    recurringResolutions: [],
    transactions
  };
}

function migrateV2ToV3(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.recurringRules) || !Array.isArray(raw.recurringResolutions)) {
    throw new Error("Finance data is missing its recurringRules or recurringResolutions list. Restore data.json from a backup.");
  }
  const recurringRules = raw.recurringRules.map((value: unknown): unknown => {
    if (!isRecord(value)) return value;
    return {
      ...value,
      kind: value.kind ?? (value.type === "income" ? "recurring-income" : "bill"),
      interval: value.interval ?? 1,
      reminderLeadDays: value.reminderLeadDays ?? 0
    };
  });
  return { ...raw, schemaVersion: 3, recurringRules };
}

function migrateV3ToV4(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.categories)) {
    throw new Error("Finance data is missing its categories list. Restore data.json from a backup.");
  }
  const categories = raw.categories.map((value: unknown): unknown => {
    if (!isRecord(value) || !("parentCategoryId" in value)) return value;
    const { parentCategoryId, ...category } = value;
    return { ...category, legacyV3ParentCategoryId: parentCategoryId };
  });
  return { ...raw, schemaVersion: 4, categories };
}

export function migrateSchema(raw: unknown): MigrationResult {
  if (raw === null || raw === undefined || !isRecord(raw)) return { data: raw, migrated: false };
  let data = raw;
  let migrated = false;
  const sourceVersion = data.schemaVersion ?? 1;
  if (sourceVersion === 1) {
    data = migrateV1ToV2(data);
    migrated = true;
  }
  if (data.schemaVersion === 2) {
    data = migrateV2ToV3(data);
    migrated = true;
  }
  if (data.schemaVersion === 3) {
    data = migrateV3ToV4(data);
    migrated = true;
  }
  return { data, migrated };
}
