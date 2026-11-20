package com.example.featureapp.feature.reports

import android.app.Activity
import android.os.Bundle

class ReportsActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_reports)
        findViewById<android.view.View>(R.id.table)
    }
}
