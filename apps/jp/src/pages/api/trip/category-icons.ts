import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { visibleCategoryNames } from '../../../lib/category-icon-access';
import {
  categoryIconStatusResponse,
  categoryIconRetryResponse,
} from '../../../lib/category-icon-api';
import { savedCategoryNames } from '../../../lib/category-collections';

async function names(locals: App.Locals) {
  return [
    ...(await savedCategoryNames(env)),
    ...(await visibleCategoryNames(locals.emdash)),
  ];
}

export const GET: APIRoute = async ({ locals }) =>
  categoryIconStatusResponse(env, await names(locals));
export const POST: APIRoute = ({ request, locals }) =>
  categoryIconRetryResponse(env, request, () => names(locals));
