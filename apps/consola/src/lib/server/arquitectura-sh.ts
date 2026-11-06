/*
 * Comprobación de arquitectura para los scripts de instalación que da la
 * consola (el del sensor remoto). Es la misma que hace despliegue/nodo/instalar.sh.
 *
 * Las imágenes de Sugardaddy solo se publican para Linux amd64 (x86_64). En
 * otro motor (arm64: Graviton, Ampere, Raspberry Pi o un Mac con Apple
 * Silicon) sus contenedores no arrancan y se reinician sin fin con «exec
 * format error». Se mira antes de escribir nada y en el motor, no con uname:
 * con Docker Desktop o un motor remoto, la máquina no es la que cuenta. Sin
 * Docker, la arquitectura de los paquetes que se instalarían. Si el motor no
 * contesta, aquí no se decide: lo dirá el paso que lo necesite.
 *
 * La línea de instalación ya se ha gastado al servir el script, así que el
 * texto dice también qué hacer para la otra máquina (despues): si no, quien
 * instala pegaría la misma línea y recibiría «ya se usó o ha caducado».
 *
 * Sin ${…} de shell dentro: el texto va en plantillas de JavaScript. que y
 * despues van entre comillas dobles de shell: sin comillas, $ ni `.
 */
export const comprobarArquitectura = (
	que: string,
	despues: string
) => `PASO="check the architecture"
plataforma=""
if command -v docker >/dev/null; then
	plataforma="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null || true)"
elif command -v dpkg >/dev/null; then
	plataforma="linux/$(dpkg --print-architecture 2>/dev/null || true)"
fi
if [[ "$plataforma" =~ ^[a-z0-9]+/[a-z0-9_]+$ && "$plataforma" != linux/amd64 ]]; then
	echo "Sugardaddy: ${que} needs a Linux amd64 (x86_64) Docker engine, and this machine has $plataforma, where its containers would not start. Install it on an x86_64 machine or VM. Nothing was changed on this one, but ${despues} (code instalar.arquitectura)" >&2
	exit 1
fi`;
