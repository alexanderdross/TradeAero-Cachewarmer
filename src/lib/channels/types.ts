export interface ChannelResult {
  success: number;
  failed: number;
  /** Set when the channel exceeded its per-channel deadline (see
   *  runAllChannels' `deadlineMs`). The URLs are counted as failed, but the
   *  flag distinguishes a slow/timed-out channel from a hard rejection. */
  timedOut?: boolean;
}
