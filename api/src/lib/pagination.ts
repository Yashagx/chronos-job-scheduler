// src/lib/pagination.ts
// Shared pagination helpers used across all list endpoints.

export interface ParsedPagination {
  page: number;
  limit: number;
  skip: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parse page/limit from query string params.
 * Clamps limit to [1, MAX_LIMIT] and page to [1, ∞).
 */
export function parsePagination(query: {
  page?: string | number;
  limit?: string | number;
}): ParsedPagination {
  const page = Math.max(1, parseInt(String(query.page ?? DEFAULT_PAGE), 10) || DEFAULT_PAGE);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(String(query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/**
 * Build the `meta` block for list responses.
 */
export function buildMeta(total: number, page: number, limit: number): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}
