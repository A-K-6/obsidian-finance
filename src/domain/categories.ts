import type { Category, CategoryType } from "@/types";

export type CategoryOption = readonly [id: string, label: string];

function compareCategories(left: Category, right: Category): number {
  const insensitive = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (insensitive !== 0) return insensitive;
  const exact = left.name.localeCompare(right.name);
  return exact !== 0 ? exact : left.id.localeCompare(right.id);
}

export function categoryLabel(categories: Category[], categoryId?: string): string {
  const category = categories.find((item) => item.id === categoryId);
  if (!category) return "Uncategorized";
  const parent = category.parentCategoryId === undefined
    ? undefined
    : categories.find((item) => item.id === category.parentCategoryId);
  const label = parent ? `${parent.name} › ${category.name}` : category.name;
  return `${label}${category.archived ? " — archived" : ""}`;
}

export function orderedCategories(categories: Category[], type?: CategoryType): Category[] {
  const included = type === undefined ? categories : categories.filter((category) => category.type === type);
  const roots = included.filter((category) => category.parentCategoryId === undefined).sort(compareCategories);
  const children = new Map<string, Category[]>();
  for (const category of included) {
    if (category.parentCategoryId === undefined) continue;
    const siblings = children.get(category.parentCategoryId) ?? [];
    siblings.push(category);
    children.set(category.parentCategoryId, siblings);
  }
  return roots.flatMap((root) => [root, ...(children.get(root.id) ?? []).sort(compareCategories)]);
}

export function categoryOptionEntries(categories: Category[], type: CategoryType, includeArchivedId?: string): CategoryOption[] {
  const active = orderedCategories(categories.filter((category) => !category.archived), type);
  const options: CategoryOption[] = active.map((category) => [category.id, categoryLabel(categories, category.id)]);
  const archivedCurrent = categories.find((category) => category.id === includeArchivedId && category.type === type && category.archived);
  if (archivedCurrent) options.push([archivedCurrent.id, categoryLabel(categories, archivedCurrent.id)]);
  return options;
}

export function parentCategoryOptionEntries(
  categories: Category[],
  type: CategoryType,
  categoryId?: string,
  includeArchivedParentId?: string
): CategoryOption[] {
  const roots = categories
    .filter((category) => category.type === type && !category.archived && category.parentCategoryId === undefined && category.id !== categoryId)
    .sort(compareCategories);
  const options: CategoryOption[] = roots.map((category) => [category.id, category.name]);
  const archivedCurrent = categories.find((category) => category.id === includeArchivedParentId
    && category.type === type && category.archived && category.parentCategoryId === undefined && category.id !== categoryId);
  if (archivedCurrent) options.push([archivedCurrent.id, `${archivedCurrent.name} — archived (current)`]);
  return options;
}
