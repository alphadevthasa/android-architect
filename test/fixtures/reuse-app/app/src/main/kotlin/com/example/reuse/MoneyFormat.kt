package com.example.reuse

// Formats an amount for display.
fun formatMoney(amount: Long, currency: String): String {
    val major = amount / 100
    val minor = amount % 100
    val padded = if (minor < 10) "0$minor" else minor.toString()
    return "$currency $major.$padded"
}
