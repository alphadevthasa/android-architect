package com.example.legacy;

import com.bumptech.glide.Glide;
import com.google.gson.Gson;
import retrofit2.Retrofit;

public class ApiModule {
    Retrofit retrofit;
    Gson gson = new Gson();
    Class<?> glide = Glide.class;
}
