# Biblioteca de la Amistad

Biblioteca digital de la **Asociación de Amistad con China**. Lee la carpeta de Google Drive
(`Textos`), saca la portada de cada libro y la muestra ordenada por **colección** y por **autor**,
con buscador, favoritos, «seguir leyendo» y modo oscuro. Se instala en el móvil como una app.

Todo es gratuito: GitHub (código y web), GitHub Actions (actualización automática) y la API de Drive.

## Cómo funciona

1. Cada día (y cuando tú lo pidas) un proceso de GitHub Actions recorre la carpeta de Drive.
2. De cada PDF o EPUB nuevo saca la portada y guarda el catálogo (`web/data/catalog.json`).
3. La web (`web/`) lee ese catálogo y lo publica en GitHub Pages.
4. Al tocar «Leer» o «Descargar», el libro se abre desde Google Drive.

La estructura de Drive se respeta: **cada carpeta de primer nivel es una colección**
(Teóricos Chinos, Teoría del PCCH, Revolución Cultural…). En las colecciones que indiques en
`config.json` (`authorFolderCollections`), **la subcarpeta es el autor**. En el resto, las
subcarpetas se muestran como secciones.

---

## Puesta en marcha, paso a paso

### 0. Comprueba que la carpeta se puede leer

La carpeta aparece en tu Drive como «Compartido conmigo» y su propietaria es la cuenta de la
Asociación. Para que el proceso pueda leerla hay dos caminos:

- **Camino A (el más sencillo):** que la carpeta esté compartida como **«Cualquier persona con el
  enlace» – Lector**. Compruébalo abriendo el enlace de la carpeta en una ventana privada del
  navegador: si se abre sin pedir cuenta, sirve.
- **Camino B:** si la carpeta debe seguir siendo privada, se comparte con el correo de una
  «cuenta de servicio» (ver el apartado *Camino B* más abajo).

En ambos casos, **quien puede cambiar el uso compartido es la propietaria de la carpeta**
(la cuenta de la Asociación), no tú.

### 1. Crea una clave de API de Google (Camino A)

1. Entra en <https://console.cloud.google.com> con tu cuenta de Google.
2. Arriba, en el selector de proyectos: **Proyecto nuevo** → nómbralo «Biblioteca AACh» → Crear.
3. Menú **APIs y servicios → Biblioteca** → busca **Google Drive API** → **Habilitar**.
4. Menú **APIs y servicios → Credenciales** → **Crear credenciales → Clave de API**.
5. Copia la clave. (Opcional: en «Restricciones de API» limítala a *Google Drive API*.)

No hace falta activar la facturación.

### 2. Crea el repositorio en GitHub

1. En GitHub: **New repository** → nombre `biblioteca-aach` → **Public** → Create.
2. Descomprime el ZIP en tu ordenador.
3. En el repositorio: **Add file → Upload files**. Arrastra **el contenido** de la carpeta
   (no la carpeta contenedora) y pulsa **Commit changes**.
4. Comprueba que existe `.github/workflows/actualizar.yml`. Si no aparece (algunos navegadores
   omiten las carpetas que empiezan por punto): **Add file → Create new file**, escribe como
   nombre `.github/workflows/actualizar.yml`, pega el contenido del archivo `actualizar.yml`
   que viene en el ZIP y confirma.

### 3. Guarda la clave como secreto

**Settings → Secrets and variables → Actions → New repository secret**

- Name: `GDRIVE_API_KEY`
- Secret: la clave del paso 1

### 4. Activa los permisos y GitHub Pages

- **Settings → Actions → General → Workflow permissions** → *Read and write permissions* → Save.
- **Settings → Pages → Build and deployment → Source** → **GitHub Actions**.

### 5. Primera ejecución

**Actions → Actualizar biblioteca → Run workflow.**

La primera vez descarga los libros para sacar las portadas, así que tarda más. Al terminar,
el resumen indica cuántos libros, autores y portadas se han procesado. Si dice que quedan
portadas pendientes, vuelve a pulsar *Run workflow* (procesa 300 por ejecución; el resto de
días es solo lo nuevo).

### 6. Abre la app e instálala

La dirección es `https://TU-USUARIO.github.io/biblioteca-aach/`.

- **Android (Chrome):** menú ⋮ → *Instalar aplicación* (o *Añadir a la pantalla de inicio*).
- **iPhone (Safari):** botón Compartir → *Añadir a la pantalla de inicio*.

---

## Ajustes

### `config.json`

| Campo | Qué hace |
| --- | --- |
| `folderId` | Identificador de la carpeta de Drive (lo que va tras `/folders/` en el enlace). |
| `siteTitle`, `siteSubtitle` | Nombre y subtítulo que se ven en la cabecera. |
| `authorFolderCollections` | Colecciones cuyas subcarpetas son autores. Ahora: `["Teóricos Chinos"]`. |
| `authorFromFilename` | `true` si los archivos se llaman «Autor - Título.pdf». |
| `authorFromMetadata` | `true` para usar el autor interno del PDF/EPUB (suele venir sucio; pruébalo y mira). |
| `collectionOrder` | Orden de las colecciones en la portada. Las que no estén aquí van después, por orden alfabético. |
| `maxDownloadMB` | Los libros más grandes no se descargan para sacar la portada; se dibuja una. |
| `maxNewCoversPerRun` | Cuántas portadas nuevas se procesan por ejecución. |

### `overrides.json` (correcciones a mano)

```json
{
  "books": {
    "Teóricos Chinos/Yuk Hui/Fragmentar el futuro.pdf": { "title": "Fragmentar el futuro", "author": "Yuk Hui" }
  },
  "authors": { "Zhang Weiying.": "Zhang Weiying" }
}
```

`books` acepta la ruta del libro dentro de la carpeta (o su `id` del catálogo) y permite cambiar
`title`, `author` y `collection`. `authors` unifica variantes de un mismo nombre.

### Cambiar el nombre de la app

Cambia `siteTitle` en `config.json`, y además `name`/`short_name` en `web/manifest.webmanifest`
y la etiqueta `<title>` de `web/index.html` (el nombre que ve el móvil al instalarla).

### Portadas que no salen

Se dibuja una portada de sustitución con el título. Pasa con archivos que no son PDF/EPUB,
PDF protegidos con contraseña, o libros de más de `maxDownloadMB`. En el resumen de la
ejecución aparece la lista de portadas con error; para reintentarlas, ejecuta el workflow con
la casilla *Reintentar las portadas que fallaron*.

---

## Camino B: carpeta privada (cuenta de servicio)

1. En Google Cloud (mismo proyecto): **IAM y administración → Cuentas de servicio → Crear**.
2. Entra en la cuenta → **Claves → Agregar clave → JSON**. Se descarga un archivo `.json`.
3. Pide a la propietaria de la carpeta que la comparta con el correo de esa cuenta de servicio
   (termina en `iam.gserviceaccount.com`) como **Lector**.
4. En GitHub crea el secreto `GDRIVE_SERVICE_ACCOUNT` con **todo el contenido** del `.json`.

Ten en cuenta que los libros solo se abrirán para quien tenga acceso a la carpeta en Drive;
el catálogo (títulos, autores y portadas) sí es visible para cualquiera que tenga el enlace de
la web, porque GitHub Pages gratuito exige repositorio público.

## Probarlo en el ordenador (sin Drive)

Descarga la carpeta de Drive, descomprímela y, desde la raíz del proyecto:

```bash
pip install -r scripts/requirements.txt
python scripts/build_catalog.py --local /ruta/a/Textos
cd web && python -m http.server 8000     # abre http://localhost:8000
```

En este modo los botones «Leer» y «Descargar» no aparecen (no hay enlace de Drive).

## Si algo falla

Los mensajes del proceso están en español. Los más habituales:

- **«Drive respondió con el código 403/404»**: la carpeta no está compartida como se necesita,
  la API de Drive no está habilitada, o la clave es incorrecta.
- **«Falta el acceso a Drive»**: no se creó el secreto o tiene otro nombre.
- **«No se ha encontrado ningún libro»**: revisa `folderId` en `config.json`.
- **«Hay N libros y la última vez había M»**: medida de seguridad para no publicar un catálogo
  a medias. Si has borrado libros a propósito, ejecuta el workflow con la casilla *Publicar aunque falten muchos libros*.

## Tipografías

Source Serif 4 y Public Sans, con licencia SIL Open Font License 1.1 (ver `web/fonts/`).
Se incluyen en el proyecto para que la web no dependa de servidores externos.
