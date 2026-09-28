import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 50;
export const TOTAL_COUNT_HEADER = "X-Total-Count";

/** `?limit=&offset=` for every list route. */
export class PageQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
}

/** Consistent list envelope: data + pagination metadata. */
export interface Page<T> {
  data: T[];
  meta: PageMeta;
}

export function buildPage<T>(data: T[], meta: PageMeta): Page<T> {
  return { data, meta };
}

/** For small, already-loaded collections: the slice for the page plus the total for `X-Total-Count`. */
export function sliceInMemory<T>(items: readonly T[], page: PageQuery): { items: T[]; total: number } {
  return { items: items.slice(page.offset, page.offset + page.limit), total: items.length };
}
