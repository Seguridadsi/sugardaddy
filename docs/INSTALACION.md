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
  `docker compose version`).
- **IP propia en la red de tus equipos** (no detrás de NAT): el atacante tiene
  que poder llegar a las trampas, y tú quieres ver su IP de verdad.
- **Salida a internet por HTTPS** (para descargar las imágenes y las
  actualizaciones).
- Entrada a la consola con **Microsoft Entra ID** (la cuenta de tu empresa):
  necesitas poder registrar una aplicación en tu tenant (te lo explicamos en el
  paso 3).

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

Las imágenes de las trampas básicas son **públicas**: el nodo las descarga solo
al arrancar. (Si prefieres no depender de ningún registro, también puedes
construirlas desde la fuente; ver [Construir las imágenes tú mismo](#construir-las-imágenes-tú-mismo).)

## 3. Prepara la entrada con Microsoft Entra ID

La consola se entra con la cuenta de tu empresa. Registra una aplicación en tu
tenant de Entra:

1. En el portal de Azure → **Microsoft Entra ID → Registros de aplicaciones →
   Nuevo registro**.
2. Nombre: `Sugardaddy`. Tipo de cuenta: solo tu organización.
3. **URI de redirección** (web): `https://<url-de-tu-consola>/auth/callback`.
4. Apunta el **Id. de aplicación (cliente)** y el **Id. de directorio
   (inquilino)**.
5. En **Certificados y secretos → Nuevo secreto de cliente**, crea uno y copia
   su **valor** (solo se ve una vez).

Guarda esos tres datos (tenant, client id, secreto): te los pide el instalador.

## 4. Instala el nodo

Desde la carpeta del repositorio, lanza el instalador indicando la carpeta donde
vivirá el nodo, un identificador, el nombre de tu empresa y la URL por la que
entrarás a la consola:

```bash
sudo despliegue/nodo/instalar.sh /opt/sugardaddy nodo-01 "Tu Empresa" consola.tuempresa.local
```

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

### La configuración de Entra

Deja los tres datos de Entra (tenant, client id, secreto) donde el instalador te
indique (variables de entorno o el fichero de entorno del nodo). Sin ellos, la
consola arranca pero no deja entrar a nadie.

## 5. Entra en la consola y siembra tu primera trampa

1. Abre `https://<url-de-tu-consola>/` en el navegador (con la CA raíz instalada
   si usaste la del nodo) y entra con tu cuenta de Entra.
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

Si no quieres depender de ningún registro, cada trampa básica se puede construir
desde su fuente (`modulos/trampas/<trampa>/imagen/`), que viene en el
repositorio. Es lo que quiere decir que las imágenes son **reconstruibles**: no
dependen de ninguna infraestructura de SeguridadSI.

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
