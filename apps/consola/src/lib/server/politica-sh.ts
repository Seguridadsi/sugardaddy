/*
 * El suelo de la política de cambios desde la instalación (docs/diseno/politica-cambios.md),
 * en bash: ACTUALIZACION_POLITICA, ACTUALIZACION_RETARDO_HORAS y ACTUALIZACION_VENTANA por
 * entorno. sd_politica_comprobar las mira antes de escribir nada; sd_politica_env las deja
 * en el .env.
 *
 * El mismo bloque va en despliegue/nodo/instalar.sh (entre sus marcas) y en el guion del
 * sensor remoto (sensores-remotos.ts). politica-sh.spec.ts comprueba que no se separan y que
 * acepta lo mismo que lee el actualizador (ventana.go) y la consola (politica-actualizacion.ts).
 */
import bloque from './politica.sh?raw';

export const POLITICA_SH: string = bloque;
