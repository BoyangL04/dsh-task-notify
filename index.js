/**
 * Host half of the task-complete notification bundle.
 *
 * The browser half owns the whole feature: it watches the Client session
 * status projection and renders the toast, so this entry exists only to place
 * a Loader row whose package the Client module scanner can find. It keeps no
 * Host state, registers no Host resource, and reads no config.
 */

/** Host plugin body — intentionally empty. */
export function apply() {}
