// SafeView — OverlayView.kt
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Full-screen overlay View drawn above other apps (TYPE_APPLICATION_OVERLAY).

package com.safeview.safeview

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.view.Gravity
import android.view.MotionEvent
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Full-screen solid-black protection layer shown when content is detected (BR-07).
 *
 * Paints an opaque black fill on every frame so underlying app content cannot show
 * through WindowManager overlays. Touch events pass through because [OverlayService]
 * sets [android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE] and
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
        isFocusableInTouchMode = false
        alpha = 1f
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription = "Content hidden by SafeView"
        setBackgroundColor(SOLID_BLACK)

        val indicator = LinearLayout(context).apply {
            layoutParams = LayoutParams(
                LayoutParams.WRAP_CONTENT,
                LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            )
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isClickable = false
            isFocusable = false
            setBackgroundColor(Color.TRANSPARENT)

            val icon = TextView(context).apply {
                text = INDICATOR_ICON
                textSize = 40f
                gravity = Gravity.CENTER
                setTextColor(Color.WHITE)
                isClickable = false
                isFocusable = false
            }
            addView(icon)

            val message = TextView(context).apply {
                text = INDICATOR_MESSAGE
                textSize = 16f
                gravity = Gravity.CENTER
                setTextColor(Color.WHITE)
                setPadding(INDICATOR_PADDING_PX, INDICATOR_PADDING_PX, INDICATOR_PADDING_PX, 0)
                isClickable = false
                isFocusable = false
            }
            addView(message)
        }
        addView(indicator)
    }

    override fun dispatchDraw(canvas: Canvas) {
        canvas.drawColor(SOLID_BLACK)
        super.dispatchDraw(canvas)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean = false

    companion object {
        /** Fully opaque black — alpha channel 0xFF, no transparency. */
        private val SOLID_BLACK: Int = 0xFF000000.toInt()

        private const val INDICATOR_ICON = "🛡"
        private const val INDICATOR_MESSAGE = "Content hidden by SafeView"
        private const val INDICATOR_PADDING_PX = 24
    }
}
