# GLACIAR · M&C Hielo — v4

Sistema de ventas, deudas y reparto para M&C Hielo.

## Arquitectura

- **Frontend:** `index.html` (una sola página, sin build).
- **PWA:** `manifest.json` + `sw.js` (shell cacheado, datos nunca cacheados).
- **Datos:** Firebase Realtime Database, nodo `glaciar_v4`.
- **Carga inicial:** `data/seed.json` se sube UNA SOLA VEZ con un botón explícito y el flag `bootstrap_done`. Después, Firebase es la única fuente de verdad.
- **Hosting:** GitHub Pages.

## Reglas anti-pisado

1. Local es solo caché de lectura. Firebase gana siempre.
2. Escrituras por registro (`update` por ID), nunca `set` del array completo.
3. Nunca se sube "todo lo local" al arrancar.
4. El botón "Subir seed a Firebase" se deshabilita para siempre tras usarse una vez.

## Deploy

1. Subir esta carpeta al repo de GitHub.
2. Settings → Pages → Branch `main` → `/root` → Save.
3. Abrir la URL de GitHub Pages.

## Carga inicial (una sola vez, desde la PC del admin)

1. Abrir la app.
2. Ir a "Sincronizar con la nube".
3. Si Firebase `glaciar_v4` está vacío → botón "Subir seed a Firebase" (se habilita).
4. Confirmar. Se sube el seed, se setea `bootstrap_done=1`, el botón se deshabilita.
5. Desde ese momento, todos los dispositivos leen de Firebase.

## Limpiar otros dispositivos

En cada celular/PC: Chrome → F12 → Application → Clear site data → cerrar y reabrir.