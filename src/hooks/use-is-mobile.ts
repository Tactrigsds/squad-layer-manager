import { useEffect, useState } from 'react'

export function useIsMobile() {
	const [isMobile, setIsMobile] = useState(false)

	useEffect(() => {
		const checkIsMobile = () => {
			// Check for touch support
			const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0

			// Check screen width (common mobile breakpoint)
			const isSmallScreen = window.innerWidth < 768

			// Check user agent for mobile devices
			const isMobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
				navigator.userAgent,
			)

			// Consider it mobile if it has touch AND (small screen OR mobile user agent)
			setIsMobile(hasTouch && (isSmallScreen || isMobileUserAgent))
		}

		// Check on mount
		checkIsMobile()

		// Check on resize
		window.addEventListener('resize', checkIsMobile)

		return () => {
			window.removeEventListener('resize', checkIsMobile)
		}
	}, [])

	return isMobile
}
