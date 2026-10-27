import { redirect } from '@sveltejs/kit';

/* Los destinos están ahora en Sensores: con sensor, en su tabla; sin él, en su sección. */
export const GET = ({ url }) => redirect(308, `/sensores${url.search}`);
