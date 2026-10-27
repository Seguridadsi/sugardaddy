# Instalar Sugardaddy Community en tu entorno

Esta guía te lleva de cero a tener Sugardaddy funcionando en tu red: un **nodo**
con tu consola, su sensor y el actualizador. Desde la consola siembras trampas
(servicios falsos que parecen de verdad) y, cuando alguien las toca, lo ves ahí
mismo. Todo ocurre en tu máquina; **nada sale a SeguridadSI**.

> Sugardaddy Community es gratis y de código libre. Trae la consola, el sensor,
> el actualizador y un conjunto de trampas básicas. Los avisos a tu correo,
> Teams, Slack o SIEM, las trampas avanzadas, el panel de flota y la máquina
> virtual ya montada son de pago (ver [el modelo](#qué-incluye-y-qué-no)).

## 1. Qué necesitas

- **Una máquina Linux** (por ejemplo Ubuntu Server 22.04 o posterior), física o
  en una máquina virtual tuya, **siempre encendida**.
- **Docker** y **Docker Compose** instalados (`docker --version`,
  `docker compose version`). Los comandos de abajo usan `sudo`; si prefieres no
  escribirlo cada vez, añade tu usuario al grupo docker una vez
  (`sudo usermod -aG docker $USER`) y vuelve a entrar en la sesión.
- **IP propia en la red de tus equipos** (no detrás de NAT): el atacante tiene
  que poder llegar a las trampas, y tú quieres ver su IP de verdad.
- **Salida a internet por HTTPS** (para descargar las imágenes y las
  actualizaciones).
- Una forma de **entrar a la consola**. Eliges entre dos (paso 3):
  **local** (usuario y contraseña del propio nodo; no necesitas Microsoft ni
  nada en la nube) o **federado** con tu **Microsoft Entra ID** (la cuenta de tu
  empresa, con tu MFA). Community viene con el **local activo** por defecto.

> **Importante sobre la red.** No instales el nodo con Docker Desktop, WSL u
> OrbStack si puedes evitarlo: esos esconden la IP de origen del atacante y las
> trampas saldrán «degradadas». Una VM Linux con Docker normal muestra bien el
> origen.

## 2. Consigue Sugardaddy Community

Clona el repositorio en la máquina Linux:

```bash
git clone https://github.com/Seguridadsi/sugardaddy.git
cd sugardaddy
```

Las imágenes del nodo (consola, sensor y actualizador) se **construyen desde la
fuente** con un solo comando en el paso 4: no dependes de ningún registro. Las
imágenes de las trampas básicas son públicas y el nodo las descarga al usarlas.

## 3. Elige cómo se entra a la consola

Dos modos. La entrada de **emergencia con llave FIDO2** sigue estando en los dos,
por si te quedas fuera.

### Opción A — Login local (lo más sencillo, el de por defecto)

Usuario y contraseña guardados en el propio nodo. **No tienes que hacer nada en
Microsoft ni registrar ninguna aplicación.** Al instalar (paso 4), la consola
crea un primer administrador y te enseña su contraseña de un solo uso; la cambias
al entrar y desde la consola das de alta al resto (**Ajustes → Usuarios locales**).

En Community está activo por defecto. En otras ediciones se enciende poniendo
`LOGIN_LOCAL=1` en el entorno del nodo.

### Opción B — Federado con tu Microsoft Entra ID

La gente entra con la cuenta de Microsoft de tu empresa (con tu MFA y tus
grupos). Registra una aplicación en tu tenant de Entra:

1. En el portal de Azure → **Microsoft Entra ID → Registros de aplicaciones →
   Nuevo registro**.
2. Nombre: `Sugardaddy`. Tipo de cuenta: solo tu organización.
3. **URI de redirección** (web): `https://<url-de-tu-consola>/auth/callback`.
4. Apunta el **Id. de aplicación (cliente)** y el **Id. de directorio
   (inquilino)**.
5. En **Certificados y secretos → Nuevo secreto de cliente**, crea uno y copia
   su **valor** (solo se ve una vez).
6. Controla **quién entra y con qué rol**: crea un **grupo de seguridad** (p. ej.
   `Sugardaddy-Acceso`) con quien deba entrar, y define los **roles de
   aplicación** (lector, operador, aprobador, admin…) asignándolos en
   *Aplicaciones empresariales → Sugardaddy → Usuarios y grupos*. La consola no
   deja pasar a quien no esté en el grupo y con un rol.

Guarda el tenant, el client id, el secreto y el id del grupo: te los pide el
instalador. Puedes tener los dos modos a la vez (local + federado); la pantalla
de entrada muestra lo que tengas configurado.

## 4. Instala el nodo

Primero, **construye las imágenes del nodo** (consola, sensor y actualizador)
desde la fuente. Este comando las deja listas y escribe el `imagenes.env` que el
instalador necesita (tarda un rato la primera vez):

```bash
sudo despliegue/nodo/construir-imagenes-local.sh
```

Después, lanza el instalador desde la carpeta del repositorio, indicando la
carpeta donde vivirá el nodo, un identificador, el nombre de tu empresa y la
**dirección por la que entrarás a la consola** (el 4º argumento).

Esa dirección es la clave: entrarás por ahí. Lo más sencillo es poner **la IP de
la máquina** (así entras por IP, sin tocar DNS ni el fichero `hosts`):

```bash
sudo despliegue/nodo/instalar.sh /opt/sugardaddy nodo-01 "Tu Empresa" 203.0.113.10
```

Si tienes un **nombre DNS** que apunta a la máquina, úsalo en su lugar
(`gestion.tuempresa.com`). Puedes cambiar la dirección más adelante volviendo a
lanzar el instalador con otra (conserva tus datos).

El instalador:

- genera los **secretos del nodo** una sola vez (los guarda en
  `/opt/sugardaddy/.env`; si ya existe, lo respeta);
- levanta la consola, el sensor, el actualizador y Postgres con Docker Compose;
- prepara el **HTTPS**. Por defecto crea una **CA propia** del nodo y deja su
  raíz en `/opt/sugardaddy/ca-raiz.crt` para que la instales en los equipos
  desde los que entres a la consola. Si prefieres tu propio certificado, pon los
  ficheros en `/opt/sugardaddy/certs/certificado.pem` y `.../clave.pem` y lanza
  el instalador con `TLS_MODO=ficheros`.

Cuando termine, te dice la URL de la consola y que ya está en marcha.

### Tu primer acceso

- **Login local** (por defecto en Community): en el primer arranque la consola
  crea el administrador `admin` y escribe su **contraseña de un solo uso** en su
  registro. Para verla:

  ```bash
  sudo sh -c 'docker logs "$(docker ps -qf name=consola)" 2>&1 | grep -A3 "PRIMER ADMINISTRADOR"'
  ```

  Apúntala (no se vuelve a mostrar) y cámbiala en el primer acceso.
- **Federado con Entra**: pon el tenant, el client id, el secreto y el id del
  grupo donde el instalador te indique (variables de entorno o el fichero de
  entorno del nodo), y relanza. Si no quieres login local a la vez, deja
  `LOGIN_LOCAL` vacío. Sin ninguno de los dos modos, la consola arranca pero solo
  se entra con la llave de emergencia.

## 5. Entra en la consola y siembra tu primera trampa

1. Abre en el navegador la dirección que pusiste al instalar: `https://<IP>/` (o
   `https://<tu-nombre>/`). Con la CA propia del nodo, el navegador avisa de que
   el certificado no es de confianza: **acéptalo** para continuar (o instala
   `/opt/sugardaddy/ca-raiz.crt` en tu equipo para que no avise). Entra con tu
   usuario local (o con tu cuenta de Entra, según el modo que hayas elegido).
2. Ve a **Trampas** (o **Destinos** → crear trampa).
3. Elige una trampa —por ejemplo **SSH (Cowrie)**—, el **puerto** por el que la
   verá el atacante (el que propone suele valer; evita puertos ya ocupados) y
   guárdala.
4. En unos segundos aparece **Activa**, y **Comprobada** cuando le llega el
   primer evento.

## 6. Compruébalo

Desde **otro equipo de tu red** (no desde la propia máquina del nodo, que falsea
la IP de origen), ataca la trampa. Para el SSH de Cowrie:

```bash
ssh -p <puerto> root@<ip-del-nodo>
```

Prueba una contraseña cualquiera. Luego, en la consola, en **Eventos**, tiene
que aparecer la línea: la IP desde la que atacaste, la trampa, y qué hiciste. Si
sale, Sugardaddy funciona de punta a punta.

## Actualizar

Las versiones nuevas salen en GitHub. En esta edición **no se instalan solas**:
te pones al día tú, desde tu clon del repositorio.

```bash
git pull
sudo despliegue/nodo/construir-imagenes-local.sh
sudo despliegue/nodo/instalar.sh /opt/sugardaddy <id> "<tu empresa>" <dirección>
```

Reinstalar **conserva tus secretos y tus datos**; solo cambia las imágenes por
las de la versión nueva. La versión solo va hacia delante: el instalador no deja
poner una anterior.

## Reinstalar o empezar de cero

Volver a lanzar el instalador sobre un nodo ya instalado lo **actualiza** y
conserva sus secretos y sus datos (`/opt/sugardaddy/.env`). Reinstalar el mismo
build, o uno más nuevo, funciona sin más; el instalador solo frena si intentas
poner una versión **más vieja** sobre una más nueva.

Si instalaste una versión anterior de la edición y el instalador se queja de que
el nodo «ya tiene una versión más nueva», borra una vez el registro de versión
del nodo y vuelve a instalar (no toca tus datos):

```bash
sudo rm /opt/sugardaddy/versiones.env
```

Si quieres **empezar de cero** (borra el nodo, sus contenedores y TODOS sus
datos, sin vuelta atrás):

```bash
cd /opt/sugardaddy && sudo docker compose -p sugardaddy down -v
sudo docker ps -aq --filter name=sd-local- | xargs -r sudo docker rm -f
sudo rm -rf /opt/sugardaddy
```

Después instala de nuevo como en el paso 4.

## Qué incluye y qué no

**Incluido (gratis):** la consola, el sensor, el actualizador, un conjunto de
trampas básicas (SSH, Redis, login web, DNS/NTP, impresora, retención)
y ver los eventos en la web de tu consola.

**De pago (no está en esta edición):** los avisos a tu correo, Teams, Slack,
webhook o SIEM (syslog CEF/LEEF, Microsoft Sentinel); las trampas avanzadas
(bases de datos, controlador de dominio, VPN, sanidad, industria, IA, cebos de
fichero…); el panel central para gestionar varios nodos; y la máquina virtual ya
montada. En la edición Community ves los eventos en la web; con un plan, además,
te llegan a donde trabajas. [Habla con SeguridadSI](https://www.seguridadsi.com).

## Construir las imágenes tú mismo

Todo es **reconstruible** desde la fuente del repositorio, sin depender de ningún
registro ni de ninguna infraestructura de SeguridadSI. Las tres imágenes del nodo
las construye `despliegue/nodo/construir-imagenes-local.sh` (es el paso 4). Cada
trampa básica también se construye desde su fuente
(`modulos/trampas/<trampa>/imagen/`), que viene en el repositorio.

## Si algo falla

- El instalador dice **en qué paso** falló; relee el mensaje y vuelve a lanzar
  la misma línea.
- Una trampa que no arranca: mira su estado en **Trampas**, la consola explica
  el motivo (puerto ocupado, imagen que no baja…).
- Una trampa «degradada» por «no se ve la IP del atacante»: el motor de
  contenedores esconde el origen (Docker Desktop, WSL, OrbStack). Usa una VM
  Linux con Docker normal.

## Cuida tus secretos

Los secretos del nodo viven en `/opt/sugardaddy/.env`. Haz **copias de
seguridad** (ver [OPERACION.md](OPERACION.md)) y guarda su clave fuera de la
máquina: sin ella, una copia no se puede restaurar.
