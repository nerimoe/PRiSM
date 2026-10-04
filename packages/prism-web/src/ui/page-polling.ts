/** One read at a time; binding reads continue after failures until the binding gate clears. */
export class PagePolling {
  private stopped = false;
  private visible = true;
  private pending = false;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;

  constructor(
    private readonly read: (signal: AbortSignal) => Promise<void>,
    private readonly interval = 3000,
    private readonly shouldPoll: () => boolean = () => true,
  ) {}

  refresh = () => {
    clearTimeout(this.timer);
    if (this.stopped || !this.visible) return;
    if (this.running) { this.pending = true; return; }
    void this.run();
  };

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) this.refresh();
    else { clearTimeout(this.timer); this.pending = false; this.controller?.abort(); }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller?.abort();
  }

  private async run() {
    this.running = true;
    this.controller = new AbortController();
    try { await this.read(this.controller.signal); }
    catch { /* The view owns error presentation; a failed read never ends polling. */ }
    finally {
      this.running = false;
      if (!this.stopped && this.visible) {
        if (this.pending) { this.pending = false; this.refresh(); }
        else this.timer = setTimeout(() => { if (this.shouldPoll()) this.refresh(); }, this.interval);
      }
    }
  }
}
