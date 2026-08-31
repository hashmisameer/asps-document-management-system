import { useEffect, useState } from 'react'

/**
 * The value, after it has stopped changing for `delayMs`.
 *
 * Used for the search box: typing "Priya" should send one request, not five,
 * and the intermediate results would only flicker past on the way to the one
 * the user meant.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
