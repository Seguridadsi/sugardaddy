# Sugardaddy Community

**Sistema de decepción y honeypots.** Sugardaddy pone en tu red servicios que
parecen de verdad —un SSH, una impresora, una base de
datos— pero son trampas. Nadie de tu empresa tiene motivo para tocarlos: quien
lo hace es un intruso, y lo sabes en ese momento, con una tasa de **cero falsos
positivos**.

La edición **Community** es gratis y de código libre. La instalas tú, en tu red,
y **todo se queda en tu casa**: los eventos, las IP y lo que prueba el atacante
no salen de tu nodo.

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
- **Trampas básicas:** SSH (Cowrie), Redis, login web, DNS/NTP,
  impresora de red y retención (tarpit).

## Qué incluye y qué no

**Gratis (esta edición):** la consola, el sensor, el actualizador, las trampas
básicas y ver los eventos en la web de tu consola.

**De pago (no está aquí):** los avisos a tu correo, Teams, Slack, webhook o SIEM
(syslog CEF/LEEF, Microsoft Sentinel); las trampas avanzadas (bases de datos,
controlador de dominio, VPN, sanidad, industria, IA, cebos de fichero…); el
panel central para gestionar varios nodos; y la máquina virtual lista para
importar. El catálogo de tu consola las enseña todas, marcadas; se encienden con
un plan, sin reinstalar nada. [Habla con SeguridadSI](https://www.seguridadsi.com).

## Tus datos, en tu empresa

Cada trampa va en su compartimento **sin salida a internet**. Lo que hace el
intruso se guarda **en tu nodo** y de ahí no sale: Sugardaddy Community no manda
nada a SeguridadSI.

## Seguridad y contribuciones

- **¿Has encontrado una vulnerabilidad?** Avísanos en privado, como cuenta
  [SECURITY.md](SECURITY.md). Nunca en una incidencia pública.
- **Fallos e ideas:** abre una incidencia. De momento no aceptamos código de
  fuera; ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

Código bajo **AGPL-3.0** (ver [LICENSE](LICENSE)). El nombre «Sugardaddy», el
logotipo y la abeja son marca de SeguridadSI y no se incluyen en esa licencia.

Sugardaddy es un producto de [SeguridadSI](https://www.seguridadsi.com).
