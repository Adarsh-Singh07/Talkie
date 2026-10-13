import WebSocket, { type ClientOptions } from "ws";

export type Message = Record<string, unknown>;
type Waiting = { resolve: (message: Message) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Attach before the socket opens. No messages are lost between awaited reads. */
export class TestSocket {
  readonly socket: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly opened: Promise<Error | undefined>;
  private readonly queued: Message[] = [];
  private readonly waiting: Waiting[] = [];
  private failure?: Error;
  private didClose = false;

  constructor(url: string, options?: ClientOptions) {
    this.socket = new WebSocket(url, options);
    this.opened = new Promise(resolve => {
      this.socket.once("open", () => resolve(undefined));
      this.socket.once("error", error => resolve(error));
      this.socket.once("close", () => resolve(new Error("socket closed before opening")));
    });
    this.closed = new Promise(resolve => {
      this.socket.once("close", (code, reason) => {
        this.didClose = true;
        this.rejectWaiters(this.failure ?? new Error(`socket closed: ${code} ${reason.toString()}`));
        resolve({ code, reason: reason.toString() });
      });
    });
    this.socket.on("error", error => { this.failure = error; this.rejectWaiters(error); });
    this.socket.on("message", data => {
      try {
        const message = JSON.parse(data.toString()) as Message;
        const waiter = this.waiting.shift();
        if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message); }
        else this.queued.push(message);
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.rejectWaiters(this.failure);
      }
    });
  }

  async open(): Promise<this> {
    const error = await this.opened;
    if (error) throw error;
    return this;
  }

  send(message: Message): void { this.socket.send(JSON.stringify(message)); }
  close(): void { this.socket.close(); }
  next(timeoutMs = 1500): Promise<Message> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure || this.didClose) return Promise.reject(this.failure ?? new Error("socket closed without another message"));
    return new Promise((resolve, reject) => {
      const waiter: Waiting = { resolve, reject, timer: setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(new Error("timed out waiting for the next WebSocket message"));
      }, timeoutMs) };
      this.waiting.push(waiter);
    });
  }

  async nextMany(count: number): Promise<Message[]> {
    const messages: Message[] = [];
    for (let i = 0; i < count; i++) messages.push(await this.next());
    return messages;
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
  }
}
