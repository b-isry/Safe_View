// SafeView — OverlayView.kt
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Full-screen overlay View drawn above other apps (TYPE_APPLICATION_OVERLAY).

package com.safeview.safeview

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView

/**
 * Full-screen protection layer shown when content is detected (BR-07).
 *
 * Touch events pass through to the app below because [OverlayService] sets
 * [android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE] and
 * [android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE] on the window.
 */
class OverlayView(context: Context) : FrameLayout(context) {

    init {
        layoutParams = LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.MATCH_PARENT,
        )
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        contentDescription = "SafeView content protection overlay"

        val tintLayer = View(context).apply {
            layoutParams = LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.MATCH_PARENT,
            )
            background = GradientDrawable().apply {
                setColor(OVERLAY_TINT_COLOR)
            }
            isClickable = false
            isFocusable = false
        }
        addView(tintLayer)

        val badge = TextView(context).apply {
            layoutParams = LayoutParams(
                LayoutParams.WRAP_CONTENT,
                LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.CENTER_HORIZONTAL,
            ).apply {
                topMargin = BADGE_TOP_MARGIN_PX
            }
            text = BADGE_LABEL
            setTextColor(Color.WHITE)
            textSize = 12f
            setBackgroundColor(Color.argb(160, 0, 180, 216))
            setPadding(BADGE_PADDING_PX, BADGE_PADDING_PX, BADGE_PADDING_PX, BADGE_PADDING_PX)
            isClickable = false
            isFocusable = false
        }
        addView(badge)
    }

    companion object {
        /** Frosted tint aligned with extension BLUR_OVERLAY_TINT (#0D1B2A @ 72%). */
        val OVERLAY_TINT_COLOR: Int = Color.argb(184, 13, 27, 42)

        private const val BADGE_LABEL = "SafeView — Protected"
        private const val BADGE_TOP_MARGIN_PX = 48
        private const val BADGE_PADDING_PX = 16
    }
}
