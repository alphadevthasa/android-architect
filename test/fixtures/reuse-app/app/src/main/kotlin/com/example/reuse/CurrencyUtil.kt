package com.example.reuse

// Copy of the money formatter (different comment, same body).
fun formatMoney(amount: Long, currency: String): String {
    val major = amount / 100
    val minor = amount % 100
    val padded = if (minor < 10) "0$minor" else minor.toString()
    return "$currency $major.$padded"
}
