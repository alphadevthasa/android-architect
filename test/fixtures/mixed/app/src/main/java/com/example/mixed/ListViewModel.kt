package com.example.mixed

import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel

class ListViewModel : ViewModel() {
    val items = MutableLiveData<List<String>>()
}
