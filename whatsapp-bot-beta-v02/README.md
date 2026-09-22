# WhatsApp Personal Bot — Beta 0.2

## Requisitos
- Node.js 20+
- Tu cuenta personal de WhatsApp con posibilidad de vincular un dispositivo

## Instalar
```bash
npm install
```

## Ejecutar
```bash
npm run dev
```

Abrir:
http://localhost:3000

## Funciones Beta 0.2
- Conexión mediante QR a WhatsApp Web.
- Lectura de contactos individuales.
- Selección múltiple con checkboxes.
- Seleccionar contactos visibles.
- Usar todos los contactos.
- Crear bloques de contactos y guardarlos localmente.
- Usar o eliminar bloques.
- Mensaje personalizado por contacto con `{{nombre}}` y `{{telefono}}`.
- Envío secuencial con espera configurable (mínimo 2.5 segundos por contacto).
- Confirmación antes del envío.
- Barra de progreso y cancelación.
- Historial en `data/messages.jsonl`.

## Archivos de datos
- `data/.wwebjs_auth/` = sesión local de WhatsApp.
- `data/blocks.json` = bloques de contactos.
- `data/messages.jsonl` = historial de envíos.

## Importante
Esta beta usa una automatización no oficial sobre WhatsApp Web. Úsala solo con contactos y comunicaciones apropiadas y revisa las reglas de WhatsApp para tu caso de uso. No incluye técnicas para evadir controles, límites o detección.
