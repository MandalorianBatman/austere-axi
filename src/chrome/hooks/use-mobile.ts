import * as React from "react"

const MOBILE_BREAKPOINT = 768

// austere-axi: `breakpoint` (the review page's sidebar needs more room than the hub's), and the first render
// already knows the width, so a narrow screen never draws the wide layout first.
export function useIsMobile(breakpoint = MOBILE_BREAKPOINT) {
  const [isMobile, setIsMobile] = React.useState<boolean>(() => window.innerWidth < breakpoint)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < breakpoint)
    }
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [breakpoint])

  return isMobile
}
