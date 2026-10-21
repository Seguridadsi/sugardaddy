/*
 * Una trampa que la consola no manda a su sensor (sin la credencial del
 * registro, un sensor demasiado antiguo, un módulo retirado…) está «en
 * espera»: el sensor la quita de su máquina y deja de informar de ella. Por
 * eso el plan escribe el motivo en trampas.donde, y la consola nunca la
 * enseña como activa en el último sitio donde estuvo. Un sensor nunca
 * informa un «donde» que empiece así.
 */
export const EN_ESPERA = 'en espera: ';

export const enEspera = (donde: string) => donde.startsWith(EN_ESPERA);
