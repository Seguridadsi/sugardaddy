/*
 * Proxy de salida y CA corporativa (docs/diseno/proxy-salida.md), en bash.
 *
 * El mismo bloque va en despliegue/nodo/instalar.sh (entre sus marcas) y en el
 * script del sensor remoto que genera la consola (sensores-remotos.ts): un nodo y
 * un sensor detrás de un banco se instalan igual. proxy-sh.spec.ts comprueba que
 * no se separan.
 *
 * Entradas, por entorno: SUGARDADDY_PROXY (o HTTPS_PROXY/https_proxy),
 * SUGARDADDY_NO_PROXY (o NO_PROXY/no_proxy) y SUGARDADDY_PROXY_CA (ruta a un PEM
 * con la CA de un proxy que inspecciona TLS). Sin ellas, lo que ya tenga la
 * carpeta en su .env; «none» quita el proxy o la CA.
 *
 * Deja: SD_PROXY, SD_NO_PROXY, SD_PROXY_CLIENTE y SD_PROXY_CA (1 o vacío), y
 * exportados los http(s)_proxy de este shell (curl, docker login). sd_proxy_sistema
 * pone apt y el almacén de CA del sistema; sd_proxy_docker, el motor de Docker
 * (las descargas de imágenes las hace él, no el contenedor); sd_proxy_env, el .env.
 */
import bloque from './proxy.sh?raw';

export const PROXY_SH: string = bloque;
