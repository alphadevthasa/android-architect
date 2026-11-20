package com.example.featureapp.feature.login

import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow

class LoginViewModel : ViewModel() {
    val busy = MutableStateFlow(false)
}
