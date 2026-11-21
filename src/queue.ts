/**
 * A FIFO queue with O(1) push and shift. `Array.prototype.shift` is O(n), which adds up for
 * mailboxes that hold thousands of messages.
 */
export class Queue<T> {
  #items: T[] = [];
  #head = 0;

  get size(): number {
    return this.#items.length - this.#head;
  }

  push(item: T): void {
    this.#items.push(item);
  }

  /** Removes and returns the oldest item, or `undefined` if the queue is empty. */
  shift(): T | undefined {
    if (this.#head === this.#items.length) return undefined;
    const item = this.#items[this.#head];
    this.#head++;
    if (this.#head === this.#items.length) {
      this.#items = [];
      this.#head = 0;
    } else if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
      // Reclaim the consumed prefix once it dominates the array.
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return item;
  }
}
