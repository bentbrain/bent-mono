import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  iconProviderStatusResponse,
  iconProviderResumeResponse,
} from '../../../../lib/category-icon-api';

export const GET: APIRoute = () => iconProviderStatusResponse(env);
export const POST: APIRoute = ({ request }) =>
  iconProviderResumeResponse(env, request);
