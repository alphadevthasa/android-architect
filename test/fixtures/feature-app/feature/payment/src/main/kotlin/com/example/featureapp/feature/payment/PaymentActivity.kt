package com.example.featureapp.feature.payment

import android.app.Activity
import android.os.Bundle

class PaymentActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_payment)
        findViewById<android.view.View>(R.id.pay)
    }
}
