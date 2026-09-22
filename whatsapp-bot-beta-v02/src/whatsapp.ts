import whatsappWeb from 'whatsapp-web.js';
import QRCode from 'qrcode';

const { Client, LocalAuth } = whatsappWeb;

type WAStatus =
  | 'starting'
  | 'qr_ready'
  | 'authenticated'
  | 'ready'
  | 'disconnected'
  | 'auth_failure';

export type ContactItem = {
  id: string;
  name: string;
  number: string;
};

export class WhatsAppService {
  private client: any;
  private qrDataUrl: string | null = null;
  private status: WAStatus = 'starting';
  private me: string | null = null;
  private lastError: string | null = null;
  private contactsCache: ContactItem[] = [];
  private contactsCacheAt = 0;

  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'personal-beta',
        dataPath: './data/.wwebjs_auth'
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      }
    });

    this.client.on('qr', async (qr: string) => {
      console.log('\nQR recibido. Escanea desde WhatsApp > Dispositivos vinculados.');
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320
        });
        this.status = 'qr_ready';
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'No se pudo generar el QR';
        console.error(this.lastError);
      }
    });

    this.client.on('authenticated', () => {
      this.qrDataUrl = null;
      this.status = 'authenticated';
      this.lastError = null;
      console.log('WhatsApp autenticado.');
    });

    this.client.on('ready', () => {
      this.status = 'ready';
      this.lastError = null;
      this.contactsCacheAt = 0;
      this.me = this.client.info?.wid?.user ?? null;
      console.log('WhatsApp conectado correctamente.');
    });

    this.client.on('auth_failure', (message: string) => {
      this.status = 'auth_failure';
      this.lastError = message;
    });

    this.client.on('disconnected', (reason: string) => {
      this.status = 'disconnected';
      this.lastError = reason;
      this.contactsCacheAt = 0;
      console.log('WhatsApp desconectado:', reason);
    });
  }

  async start(): Promise<void> {
    this.status = 'starting';
    await this.client.initialize();
  }

  getState() {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      me: this.me,
      lastError: this.lastError
    };
  }

  async listContacts(search = ''): Promise<ContactItem[]> {
    if (this.status !== 'ready') {
      throw new Error('WhatsApp todavía no está conectado.');
    }

    const now = Date.now();
    if (!this.contactsCache.length || now - this.contactsCacheAt > 30_000) {
      const contacts = await this.client.getContacts();

      this.contactsCache = contacts
        .filter((c: any) => c.isMyContact && !c.isMe && !c.isGroup)
        .map((c: any) => ({
          id: c.id._serialized,
          name: c.name || c.pushname || c.number || c.id.user || 'Sin nombre',
          number: c.number || c.id.user || ''
        }))
        .filter((c: ContactItem) => /^\d+$/.test(c.id.split('@')[0]))
        .sort((a: ContactItem, b: ContactItem) => a.name.localeCompare(b.name, 'es'));

      this.contactsCacheAt = now;
    }

    const query = search.trim().toLowerCase();
    if (!query) return this.contactsCache;

    return this.contactsCache.filter((c) =>
      `${c.name} ${c.number}`.toLowerCase().includes(query)
    );
  }

  async sendText(contactId: string, message: string): Promise<void> {
    if (this.status !== 'ready') {
      throw new Error('WhatsApp no está conectado.');
    }

    const cleanMessage = message.trim();
    if (!cleanMessage) throw new Error('El mensaje no puede estar vacío.');
    if (!/^\d+@c\.us$/.test(contactId)) {
      throw new Error(`Destino inválido: ${contactId}`);
    }

    await this.client.sendMessage(contactId, cleanMessage);
  }
}
