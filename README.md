# Sugardaddy Community

**Sistema de decepción y honeypots.** Sugardaddy pone en tu red servicios que
parecen de verdad —un SSH, una impresora, una base de
datos— pero son trampas. Nadie de tu empresa tiene motivo para tocarlos: quien
lo hace es un intruso, y lo sabes en ese momento, con una tasa de **cero falsos
positivos**.

La edición **Community** es gratis. La instalas tú, en tu red, y **todo se queda
en tu casa**: los eventos, las IP y lo que prueba el atacante no salen de tu nodo.
La consola, el sensor, el actualizador y la trampa SSH (Cowrie) son de código libre
y no piden registro. Con tu correo confirmado activas, sin coste, más trampas, ya
cerradas, y las actualizaciones automáticas.

## Empezar

- **Instalar en tu entorno:** [docs/INSTALACION.md](docs/INSTALACION.md)
- **Operar y mantener (desplegar trampas, actualizar, copias):**
  [docs/OPERACION.md](docs/OPERACION.md)

En resumen: un **Linux con Docker** siempre encendido y con IP propia en tu red,
el instalador deja tu consola en marcha, entras con tu cuenta de Microsoft Entra
ID, siembras trampas y ves los eventos en la web.

## Qué es un nodo

- **Consola:** la web desde la que gestionas tus trampas y ves lo que pasa.
- **Sensor:** donde corren las trampas, aisladas y sin salida a internet.
- **Actualizador:** mantiene el nodo al día con versiones firmadas.
- **Trampa sin registro:** SSH (Cowrie), con su código en este repositorio.
- **Trampas con registro gratuito:** SMB, RDP, Redis, login web, DNS/NTP, impresora
  de red y retención (tarpit) por SSH y por web. Son imágenes cerradas: aquí está
  su manifiesto, no su código.

## Qué incluye y qué no

**Community sin registro (código libre):** la consola, el sensor, el actualizador,
la trampa SSH y ver los eventos en la web de tu consola.

**Community con registro (gratis):** además, las trampas de registro y las
actualizaciones automáticas. Se activa en **Ajustes → Registro gratuito**: das tu
correo, lo confirmas, recibes un código de activación y lo pegas ahí. La licencia
dura un año y el nodo la renueva solo. La casilla de novedades es aparte y opcional.

**En Sugardaddy Cloud (no está aquí):** los avisos a tu correo, Teams, Slack, webhook o SIEM
(syslog CEF/LEEF, Microsoft Sentinel); las trampas avanzadas (bases de datos,
controlador de dominio, VPN, sanidad, industria, IA, cebos de fichero…); el
panel central para gestionar varios nodos; y la máquina virtual lista para
importar. El catálogo de tu consola las enseña todas, marcadas; se encienden con
Cloud, sin reinstalar nada. [Habla con SeguridadSI](https://www.seguridadsi.com).

## Tus datos, en tu empresa

Cada trampa va en su compartimento **sin salida a internet**. Lo que hace el
intruso se guarda **en tu nodo** y de ahí no sale. Sin registro, Sugardaddy Community
no manda nada a SeguridadSI. Si te registras, SeguridadSI recibe tu correo y el nombre
y la versión del nodo, y el nodo pide de vez en cuando la renovación de su licencia;
nunca eventos, IP ni nada de lo que pasa en tus trampas.

## Seguridad y contribuciones

- **¿Has encontrado una vulnerabilidad?** Avísanos en privado, como cuenta
  [SECURITY.md](SECURITY.md). Nunca en una incidencia pública.
- **Fallos e ideas:** abre una incidencia. De momento no aceptamos código de
  fuera; ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

El código de este repositorio va bajo **AGPL-3.0** (ver [LICENSE](LICENSE)). Las
imágenes de las trampas de registro son cerradas y no entran en esa licencia. El
nombre «Sugardaddy», el logotipo y la abeja son marca de SeguridadSI y tampoco.

Sugardaddy es un producto de [SeguridadSI](https://www.seguridadsi.com).
