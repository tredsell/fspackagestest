import { CJ4_FMC } from "WorkingTitle";

export abstract class CJ4_FMC_Page {
  private static _instance: CJ4_FMC_Page;
  private _isDirty: boolean = true;

  public refreshInterval: number = 1000;

  set isDirty(v) {
    this._isDirty = v;
  }

  constructor(private _fmc: CJ4_FMC) { }

  /** Returns a boolean indicating if the page should run a timer to call update() */
  abstract hasRefresh(): boolean;

  /** Updates and evaluates data looking for changes
    * Should set {@link CJ4_FMC_Page#isDirty} to true when data has changed. 
  */
  abstract update(): void;

  //** Renders the page */
  abstract render(): void;

  invalidate(): void {
    this._isDirty = true;
    this._fmc.clearDisplay();
    this.render();
    this.bindEvents();
    this._isDirty = false;
  }
  abstract bindEvents(): void;
}