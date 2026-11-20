package com.example.featureapp.feature.login

import androidx.compose.material3.Button
import androidx.compose.runtime.Composable
import com.example.featureapp.feature.payment.PaymentPresenter

@Composable
fun LoginScreen(onDone: () -> Unit) {
    Button(onClick = onDone) {}
}

fun upsell(): String = PaymentPresenter().title()
