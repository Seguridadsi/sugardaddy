import { env } from '$env/dynamic/private';

/*
 * La edición community (gratis) no trae los señuelos de pago (ficheros, nube),
 * que son lo único que se despliega en un destino SIN sensor por la vía manual.
 * Así que en community «añadir un destino a mano» no tiene nada que ofrecer: se
 * oculta. Las máquinas con sensor siguen apareciendo como destinos solas.
 */
export const esCommunity = () => env.EDICION === 'community';
