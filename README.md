# SeenIt - Seguimiento de Series y Películas

Una aplicación PWA 100% privada para seguimiento de series y películas usando TMDB como base de datos y Google Drive para almacenamiento sincronizado.

## 🎯 Características

- ✅ **Privada**: Todos los datos se almacenan localmente o en tu Drive personal
- ✅ **PWA**: Funciona offline con Service Worker
- ✅ **Responsive**: Compatible con móvil, tablet y desktop
- ✅ **Sincronización**: Google Drive opcional
- ✅ **Sin servidores**: 100% cliente-side
- ✅ **TMDB Integration**: Base de datos completa de series y películas

---

## 🚀 Setup Rápido

### 1️⃣ Configurar Credenciales

Antes de usar la app, necesitas configurar tus credenciales de API:

#### TMDB API Key (Gratuita)
1. Ve a https://www.themoviedb.org/settings/api
2. Crea una cuenta (si no tienes una)
3. Solicita una API Key
4. Copia la API Key

#### Google Drive OAuth (Gratuito)
1. Ve a https://console.cloud.google.com/
2. Crea un nuevo proyecto o selecciona uno existente
3. Habilita "Google Drive API"
4. Ve a "Credenciales" → "Crear Credencial" → "OAuth 2.0 ID de Cliente"
5. Configura:
   - Tipo: Aplicación web
   - Orígenes autorizados: `http://localhost:5500`
   - URIs de redirección: `http://localhost:5500/index.html`
6. Copia el Client ID y API Key

#### Crear config.js
1. Copia `config.example.js` y renómbralo a `config.js`
2. Reemplaza los valores de ejemplo con tus credenciales reales
3. **NUNCA** hagas commit de `config.js` (está en `.gitignore`)

```javascript
// config.js
const CONFIG_TMDB_API_KEY = 'tu_api_key_real_aqui';
const CONFIG_GOOGLE_CLIENT_ID = 'tu_client_id_real_aqui.apps.googleusercontent.com';
const CONFIG_GOOGLE_API_KEY = 'tu_google_api_key_aqui';
```

### 2️⃣ Iniciar el Servidor

#### Opción A: Python (Recomendado)
```bash
python server.py
# o en Python 3
python3 server.py
```

Luego abre: http://localhost:5500

#### Opción B: Node.js (http-server)
```bash
npx http-server -p 5500 -c-1
```

#### Opción C: Cualquier otro servidor web
```bash
# Con PHP
php -S localhost:5500

# Con Node.js (http-server globalmente instalado)
http-server -p 5500
```

---

## 📋 Problemas Encontrados y Solucionados

### ✅ Problema 1: Falta Inicialización de la Aplicación
**Síntoma**: Página en blanco o errores en consola
**Causa**: No había llamada a `initApp()` cuando se cargaba la página
**Solución**: Se agregó listener de `DOMContentLoaded` en `index.html` para llamar a `initApp()`

### ✅ Problema 2: Service Worker con Rutas Incorrectas
**Síntoma**: Service Worker no se registraba o fallaba
**Causa**: Rutas absolutas (`/sw.js`) no funcionan correctamente en localhost
**Solución**: Cambié a rutas relativas (`./sw.js`)

### ✅ Problema 3: Manifest.json con Rutas Absolutas
**Síntoma**: PWA no se installaba correctamente
**Causa**: `"start_url": "/index.html"` y `"scope": "/"` son rutas absolutas
**Solución**: Cambié a `"start_url": "./index.html"` y `"scope": "./"`

### ✅ Problema 4: CORS y Headers en Servidor
**Síntoma**: Posibles errores de CORS con Google APIs
**Causa**: El servidor necesita headers CORS correctos
**Solución**: Proporcioné `server.py` con CORS habilitado correctamente

### ✅ Problema 5: Credenciales Expuestas en el Código
**Síntoma**: API Keys visibles en el código fuente
**Causa**: Las credenciales estaban hardcodeadas en los servicios
**Solución**: 
- Creé `config.example.js` como plantilla
- Añadí `.gitignore` para evitar que `config.js` se commitee
- Incluí documentación sobre dónde obtener las credenciales

### ✅ Problema 6: Listener DOMContentLoaded Duplicado
**Síntoma**: Inicialización doble o comportamiento inconsistente
**Causa**: `app.js` tenía su propio listener que conflictaba con el de HTML
**Solución**: Removí el listener del `app.js`

---

## 🔧 Estructura de Archivos

```
SeenIt2/
├── index.html           # Interfaz principal
├── app.js              # Lógica de la aplicación
├── tmdb-service.js     # Integración con TMDB API
├── drive-service.js    # Integración con Google Drive
├── sw.js               # Service Worker (caching offline)
├── manifest.json       # Configuración PWA
├── server.py           # Servidor Python con CORS
├── config.example.js   # Plantilla de configuración (COPIAR A config.js)
├── config.js           # ⚠️ NO COMMITEAR (tu configuración real)
├── .gitignore          # Archivos a ignorar en git
└── README.md           # Este archivo
```

---

## 🛠️ Troubleshooting

### "Error TMDB: 401" o "API Key inválida"
- Verifica que tu `config.js` tiene la API Key correcta
- Confirma que la API Key está habilitada en TMDB

### "Error de autenticación con Google Drive"
- Verifica que Google Drive API está habilitada
- Confirma que `http://localhost:5500` está en "Orígenes autorizados"
- Limpia el localStorage y vuelve a intentar
- En consola: `localStorage.clear()`

### "Puerto 5500 ya en uso"
```bash
# En Windows - encuentra qué usa el puerto
netstat -ano | findstr :5500

# En Linux/Mac
lsof -i :5500

# Luego mata el proceso o cambia el puerto en server.py
```

### "Service Worker no se registra"
1. Abre DevTools → Console
2. Verifica que no hay errores de CORS
3. Comprueba que `sw.js` existe en la carpeta raíz
4. En DevTools → Application → Service Workers verifica el estado

### Datos no se sincronizan con Drive
1. Verifica conexión a internet
2. Abre DevTools → Network para ver si las peticiones se envían
3. En consola busca errores: `[Drive]` y `[App]`
4. Intenta desconectar y reconectar Drive

---

## 📱 Uso de la App

### Agregar Series/Películas
1. Ve a la pestaña "🔍 Buscar"
2. Escribe el nombre de la serie o película
3. Haz clic en "+ Añadir"

### Editar Detalles
1. Haz clic en la película/serie en tu lista
2. Modifica puntuación, estado, episodios visto
3. Haz clic en "💾 Guardar"

### Sincronizar con Drive
1. Ve a "⚙️ Ajustes"
2. Haz clic en "🔗 Conectar Google Drive"
3. Autoriza la aplicación
4. Tus datos se sincronizarán automáticamente

### Exportar/Importar
1. Ve a "⚙️ Ajustes"
2. "📤 Exportar datos" descarga un JSON
3. "📥 Importar datos" carga un JSON

---

## 🔒 Privacidad y Seguridad

- ✅ **Datos locales**: Se almacenan en `localStorage` de tu navegador
- ✅ **Drive**: Si conectas Drive, tus datos se sincronizarán de forma privada
- ✅ **TMDB**: Solo se descargan datos públicos de películas/series
- ✅ **Sin tracking**: No hay analytics ni tracking de datos
- ⚠️ **Credenciales**: Mantenlas privadas en `config.js` (nunca en Git)

---

## 🚀 Deploy (Opcional)

Para deployar en producción:

1. **Actualiza credenciales OAuth**:
   - Añade tu dominio en Google Console
   - Cambia localhost por tu dominio

2. **Usa HTTPS**:
   - Google OAuth requiere HTTPS en producción
   - Service Worker también necesita HTTPS

3. **Ejemplos de deploy**:
   - **Vercel**: `vercel deploy`
   - **Netlify**: `netlify deploy`
   - **GitHub Pages**: Push a `main` branch
   - **Tu servidor**: `scp -r * user@host:/var/www/seenit`

---

## 📚 Documentación de APIs

- [TMDB API](https://developers.themoviedb.org/3)
- [Google Drive API](https://developers.google.com/drive/api)
- [Web APIs - Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [PWA Manifest](https://developer.mozilla.org/en-US/docs/Web/Manifest)

---

## 📝 Licencia

MIT License - Libre para usar y modificar

---

## 🐛 Reportar Bugs

Si encuentras algún problema:

1. Abre DevTools (F12)
2. Ve a Console
3. Busca mensajes de error (normalmente con prefijos `[App]`, `[Drive]`, `[TMDB]`, `[SW]`)
4. Copia el error completo y el contexto

---

**Última actualización**: Mayo 2026
**Versión**: 1.0.0
