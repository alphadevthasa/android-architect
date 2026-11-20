package com.example.reuse

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

@Composable
fun Banner(message: String) {
    Box {
        Text(text = message, color = Color(0xFF00FF00))
    }
}
