package com.example.mixed

import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow

data class ProfileUiState(val name: String = "")

class ProfileViewModel : ViewModel() {
    val state = MutableStateFlow<ProfileUiState>(ProfileUiState())
}
