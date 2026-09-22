import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WhatsAppService, type ContactItem } from './whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'src', 'public');
const dataDir = path.join(rootDir, 'data');
const logFile = path.join(dataDir, 'messages.jsonl');
const blocksFile = path.join(dataDir, 'blocks.json');

await fs.mkdir(dataDir, { recursive: true });

const app = express();
const port = Number(process.env.PORT ?? 3000);
const wa = new WhatsAppService();

app.use(express.json({ limit: '128kb' }));
app.use(express.static(publicDir));

interface ContactBlock {
  id: string;
  name: string;
  contactIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface SendJobContact extends ContactItem {
  status: 'pending' | 'sending' | 'sent' | 'error' | 'skipped';
  error?: string;
}

interface SendJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  message: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  delayMs: number;
  contacts: SendJobContact[];
  sent: number;
  failed: number;
  cancelled: boolean;
  error?: string;
}

const jobs = new Map<string, SendJob>();
let activeJobId: string | null = null;

async function readBlocks(): Promise<ContactBlock[]> {
  try {
    const raw = await fs.readFile(blocksFile, 'utf8');
    return JSON.parse(raw) as ContactBlock[];
  } catch {
    return [];
  }
}

async function writeBlocks(blocks: ContactBlock[]): Promise<void> {
  await fs.writeFile(blocksFile, JSON.stringify(blocks, null, 2), 'utf8');
}

async function appendLog(record: Record<string, unknown>) {
  await fs.appendFile(logFile, JSON.stringify(record) + '\n', 'utf8');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeInt(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

app.get('/api/status', (_req, res) => {
  res.json(wa.getState());
});

app.get('/api/contacts', async (req, res) => {
  try {
    const search = String(req.query.search ?? '');
    const contacts = await wa.listContacts(search);
    res.json({ contacts, total: contacts.length });
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : 'No se pudieron cargar los contactos.'
    });
  }
});

app.get('/api/blocks', async (_req, res) => {
  try {
    const blocks = await readBlocks();
    res.json({ blocks });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'No se pudieron cargar los bloques.' });
  }
});

app.post('/api/blocks', async (req, res) => {
  try {
    const { name, contactIds } = req.body as { name?: string; contactIds?: string[] };
    const cleanName = String(name ?? '').trim();
    const ids = Array.from(new Set((contactIds ?? []).map(String).filter((id) => /^\d+@c\.us$/.test(id))));

    if (!cleanName) return res.status(400).json({ error: 'El nombre del bloque es obligatorio.' });
    if (!ids.length) return res.status(400).json({ error: 'Selecciona al menos un contacto.' });

    const blocks = await readBlocks();
    if (blocks.some((b) => b.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(409).json({ error: 'Ya existe un bloque con ese nombre.' });
    }

    const now = new Date().toISOString();
    const block: ContactBlock = {
      id: crypto.randomUUID(),
      name: cleanName,
      contactIds: ids,
      createdAt: now,
      updatedAt: now
    };

    blocks.push(block);
    await writeBlocks(blocks);
    res.status(201).json({ block });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'No se pudo crear el bloque.' });
  }
});

app.delete('/api/blocks/:id', async (req, res) => {
  try {
    const blocks = await readBlocks();
    const next = blocks.filter((b) => b.id !== req.params.id);
    if (next.length === blocks.length) return res.status(404).json({ error: 'Bloque no encontrado.' });
    await writeBlocks(next);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'No se pudo eliminar el bloque.' });
  }
});

app.post('/api/send', async (req, res) => {
  try {
    const body = req.body as {
      contactIds?: string[];
      message?: string;
      delayMs?: number;
    };

    const ids = Array.from(new Set((body.contactIds ?? []).map(String).filter((id) => /^\d+@c\.us$/.test(id))));
    const message = String(body.message ?? '').trim();

    if (!ids.length) return res.status(400).json({ error: 'Debes seleccionar al menos un contacto.' });
    if (!message) return res.status(400).json({ error: 'El mensaje es obligatorio.' });
    if (activeJobId) return res.status(409).json({ error: 'Ya hay un envío en curso. Espera a que termine.' });

    const allContacts = await wa.listContacts();
    const byId = new Map(allContacts.map((c) => [c.id, c]));
    const selectedContacts = ids.map((id) => byId.get(id)).filter(Boolean) as ContactItem[];

    if (!selectedContacts.length) return res.status(400).json({ error: 'No se encontraron contactos válidos.' });

    // No permitimos acelerar el envío por debajo de 2.5 s por contacto.
    const delayMs = Math.max(2500, Math.min(safeInt(body.delayMs, 3500), 30_000));

    const job: SendJob = {
      id: crypto.randomUUID(),
      status: 'queued',
      message,
      createdAt: new Date().toISOString(),
      delayMs,
      contacts: selectedContacts.map((c) => ({ ...c, status: 'pending' })),
      sent: 0,
      failed: 0,
      cancelled: false
    };

    jobs.set(job.id, job);
    activeJobId = job.id;
    void runSendJob(job).catch(async (error) => {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Error desconocido.';
      job.finishedAt = new Date().toISOString();
      activeJobId = null;
    });

    res.status(202).json({ jobId: job.id, total: job.contacts.length, delayMs: job.delayMs });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'No se pudo iniciar el envío.' });
  }
});

app.get('/api/send/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Envío no encontrado.' });
  res.json({
    id: job.id,
    status: job.status,
    message: job.message,
    total: job.contacts.length,
    sent: job.sent,
    failed: job.failed,
    cancelled: job.cancelled,
    current: job.contacts.find((c) => c.status === 'sending')?.name ?? null,
    contacts: job.contacts.map((c) => ({ id: c.id, name: c.name, number: c.number, status: c.status, error: c.error })),
    error: job.error
  });
});

app.post('/api/send/:jobId/cancel', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Envío no encontrado.' });
  if (job.status !== 'queued' && job.status !== 'running') return res.status(400).json({ error: 'Este envío ya terminó.' });
  job.cancelled = true;
  res.json({ ok: true });
});

async function runSendJob(job: SendJob) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  for (let i = 0; i < job.contacts.length; i += 1) {
    if (job.cancelled) {
      for (let j = i; j < job.contacts.length; j += 1) {
        if (job.contacts[j].status === 'pending') job.contacts[j].status = 'skipped';
      }
      break;
    }

    const contact = job.contacts[i];
    contact.status = 'sending';

    const personalizedMessage = job.message
      .replaceAll('{{nombre}}', contact.name)
      .replaceAll('{{telefono}}', contact.number);

    try {
      await wa.sendText(contact.id, personalizedMessage);
      contact.status = 'sent';
      job.sent += 1;

      await appendLog({
        timestamp: new Date().toISOString(),
        jobId: job.id,
        contactId: contact.id,
        contactName: contact.name,
        message: personalizedMessage
      });
    } catch (error) {
      contact.status = 'error';
      contact.error = error instanceof Error ? error.message : 'No se pudo enviar.';
      job.failed += 1;

      await appendLog({
        timestamp: new Date().toISOString(),
        jobId: job.id,
        contactId: contact.id,
        contactName: contact.name,
        message: personalizedMessage,
        error: contact.error
      });
    }

    if (i < job.contacts.length - 1 && !job.cancelled) {
      await sleep(job.delayMs);
    }
  }

  job.status = job.cancelled ? 'cancelled' : 'completed';
  job.finishedAt = new Date().toISOString();
  activeJobId = null;
}

app.listen(port, () => {
  console.log(`\nWhatsApp Bot Beta 0.2: http://localhost:${port}`);
  console.log('Elige contactos, bloques o todos los contactos desde la interfaz.');
});

wa.start().catch((error) => {
  console.error('Error inicializando WhatsApp:', error);
});
