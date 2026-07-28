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

export function migrateSchema(raw: unknown): MigrationResult {
  if (raw === null || raw === undefined) return { data: raw, migrated: false };
  if (!isRecord(raw)) return { data: raw, migrated: false };
  const schemaVersion = raw.schemaVersion ?? 1;
  if (schemaVersion !== 1) return { data: raw, migrated: false };
  if (!Array.isArray(raw.accounts) || !Array.isArray(raw.transactions)) {
    throw new Error("Finance data is missing its accounts or transactions list. Restore data.json from a backup.");
  }

  const categories = new Map<string, Category>();
  const categoryIds = new Map<string, string>();
  const usedIds = new Map<string, string>();
  const rawTransactions = raw.transactions as unknown[];
  const transactions = rawTransactions.map((value) => {
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
    migrated: true,
    data: {
      ...raw,
      schemaVersion: 2,
      settings,
      categories: [...categories.values()],
      budgets: [],
      recurringRules: [],
      recurringResolutions: [],
      transactions
    }
  };
}
