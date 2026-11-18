package com.example.mixed

import android.content.Context

class Prefs(context: Context) {
    private val prefs = context.getSharedPreferences("app", Context.MODE_PRIVATE)
}
